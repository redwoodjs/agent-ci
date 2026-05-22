use crate::RunArgs;
use crate::docker::{
    ContainerBindsOpts, ContainerCmdOpts, ContainerEnvOpts, DockerCliRuntime, DockerSocketProbe,
    build_container_binds, build_container_cmd, build_container_env, resolve_docker_api_url,
    resolve_docker_extra_hosts, resolve_docker_socket,
};
use crate::dtu::{DtuHttpClient, start_ephemeral_dtu};
use crate::env::resolve_repo_root;
use crate::expr::{ExpressionContext, RunnerContext, evaluate_job_if, expand_expressions};
use crate::macos_vm::{
    CommandMacosVmRuntime, CommandRunnerBinaryIo, HostCapability, MacosVmJobPlan, SshCreds,
    check_macos_vm_host, ensure_macos_runner_binary, execute_macos_vm_job,
    resolve_macos_runner_version, resolve_macos_vm_image,
};
use crate::matrix::{MatrixContext, expand_workflow_jobs};
use crate::runner::{
    DtuControlPlane, DtuJobContainer, DtuJobSeed, DtuJobStep, DtuRunnerRegistration,
    JobExecutionPlan, JobResult, NeedContext, PausedSignal, ServiceSpec, StepStatus,
    execute_registered_runner_job_with_pause_observer, parse_timeline_steps,
    wrap_pause_on_failure_steps,
};
use crate::runner_image::{discover_runner_image, ensure_runner_image};
use crate::state::{
    JobResultInput, RunResultInput, StateDirEnv, StepResultInput,
    StepResultStatus as StateStepResultStatus, create_log_context, resolve_logs_dir,
    resolve_state_dir, write_run_result,
};
use crate::workflow::{
    RunsOn, WorkflowDocument, WorkflowJob, WorkflowParseError, WorkflowStep, extract_events,
    is_workflow_relevant, parse_workflow_file,
};
use crate::workspace::sync_worktree_to_workspace;
use std::collections::BTreeMap;
use std::fs;
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowDiscovery {
    pub workflow_path: PathBuf,
    pub repo_root: PathBuf,
    pub effective_sha: EffectiveSha,
    pub jobs: Vec<RunnableJob>,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllWorkflowDiscovery {
    pub repo_root: PathBuf,
    pub branch: String,
    pub changed_files: Vec<String>,
    pub relevant: Vec<PathBuf>,
    pub skipped: Vec<SkippedWorkflow>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedWorkflow {
    pub path: PathBuf,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnableJob {
    pub id: String,
    pub display_name: String,
    pub runs_on: Option<String>,
    pub uses: Option<String>,
    pub step_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunPlan {
    pub repo_root: PathBuf,
    pub effective_sha: EffectiveSha,
    pub selection: RunSelection,
    pub workflows: Vec<WorkflowRunPlan>,
    pub max_jobs: Option<u32>,
    pub pause_on_failure: bool,
    pub no_matrix: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunSelection {
    SingleWorkflow,
    AllRelevant {
        branch: String,
        changed_files: Vec<String>,
        skipped: Vec<SkippedWorkflow>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowRunPlan {
    pub workflow_path: PathBuf,
    pub diagnostics: Vec<String>,
    pub jobs: Vec<PlannedJob>,
    pub schedule: Vec<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedJob {
    pub id: String,
    pub display_name: String,
    pub runner_name: String,
    pub target: PlannedJobTarget,
    pub needs: Vec<String>,
    pub if_condition: Option<String>,
    pub env: BTreeMap<String, String>,
    pub outputs: BTreeMap<String, String>,
    pub services: Vec<ServiceSpec>,
    pub container: Option<DtuJobContainer>,
    pub steps: Vec<PlannedStep>,
    pub step_count: usize,
    pub matrix_context: Option<MatrixContext>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedStep {
    pub id: Option<String>,
    pub name: String,
    pub index: usize,
    pub run: Option<String>,
    pub uses: Option<String>,
    pub if_condition: Option<String>,
    pub shell: Option<String>,
    pub working_directory: Option<String>,
    pub env: BTreeMap<String, String>,
    pub with: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlannedJobTarget {
    Linux { runs_on: String },
    MacOs { runs_on: String },
    ReusableWorkflow { uses: String },
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobResultStatus {
    Success,
    Failure,
    Skipped,
    Cancelled,
}

impl JobResultStatus {
    const fn as_github_result(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Failure => "failure",
            Self::Skipped => "skipped",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobRunDecision {
    Run,
    Skip { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobExecutionRoute {
    Linux,
    MacOs,
    Skip { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectiveSha {
    pub head_sha: String,
    pub sha_ref: Option<String>,
    pub source: EffectiveShaSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffectiveShaSource {
    Explicit,
    DirtyTree,
    Head,
}

pub fn run_run_command(args: RunArgs, stdout: &mut impl Write, stderr: &mut impl Write) -> i32 {
    if should_launch_detached(&args) {
        return run_detached_launcher(stdout, stderr);
    }

    let current_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    match plan_run(&args, &current_dir) {
        Ok(plan) => {
            let json_mode = json_mode_enabled(&args);
            let sentinel_mode = json_mode || is_detached_worker();
            if json_mode {
                emit_run_start_event(&plan, stdout);
            }

            if plan.workflows.is_empty() {
                if let RunSelection::AllRelevant { branch, .. } = &plan.selection {
                    if !json_mode {
                        let _ = writeln!(
                            stdout,
                            "[Agent CI] No relevant workflows found for branch '{branch}'."
                        );
                    }
                    if sentinel_mode {
                        emit_run_finish_event("passed", stdout);
                    }
                    return 0;
                }
            }

            if !json_mode {
                write_plan_summary(&plan, stdout);
            }
            let exit_code = execute_run_plan(&plan, stdout, stderr, sentinel_mode);
            if sentinel_mode {
                emit_run_finish_event(if exit_code == 0 { "passed" } else { "failed" }, stdout);
            }
            exit_code
        }
        Err(err) => {
            let _ = writeln!(stderr, "[Agent CI] Error: {err}");
            1
        }
    }
}

pub fn plan_run(args: &RunArgs, current_dir: &Path) -> Result<RunPlan, RunDiscoveryError> {
    if args.run_all {
        return plan_all_workflows(args, current_dir);
    }

    let discovery = discover_workflow_run(args, current_dir)?;
    let workflow = parse_workflow_file(&discovery.workflow_path)?;
    Ok(RunPlan {
        repo_root: discovery.repo_root.clone(),
        effective_sha: discovery.effective_sha.clone(),
        selection: RunSelection::SingleWorkflow,
        workflows: vec![plan_workflow_document(args, &workflow, 1)],
        max_jobs: args.max_jobs,
        pause_on_failure: args.pause_on_failure,
        no_matrix: args.no_matrix,
    })
}

pub fn plan_all_workflows(
    args: &RunArgs,
    current_dir: &Path,
) -> Result<RunPlan, RunDiscoveryError> {
    let discovery = discover_all_workflows(current_dir)?;
    let effective_sha = resolve_effective_sha(&discovery.repo_root, args.sha.as_deref())?;
    let mut workflows = Vec::new();

    for (index, path) in discovery.relevant.iter().enumerate() {
        let workflow = parse_workflow_file(path)?;
        workflows.push(plan_workflow_document(args, &workflow, (index + 1) as u32));
    }

    Ok(RunPlan {
        repo_root: discovery.repo_root,
        effective_sha,
        selection: RunSelection::AllRelevant {
            branch: discovery.branch,
            changed_files: discovery.changed_files,
            skipped: discovery.skipped,
        },
        workflows,
        max_jobs: args.max_jobs,
        pause_on_failure: args.pause_on_failure,
        no_matrix: args.no_matrix,
    })
}

pub fn plan_workflow_document(
    args: &RunArgs,
    workflow: &WorkflowDocument,
    base_run_num: u32,
) -> WorkflowRunPlan {
    let diagnostics = workflow
        .diagnostics
        .iter()
        .map(|diagnostic| diagnostic.message.clone())
        .collect();
    let jobs = expand_workflow_jobs(workflow, args.no_matrix, base_run_num)
        .into_iter()
        .filter_map(|expanded| {
            let job = workflow.jobs.get(&expanded.job_id)?;
            let env = merged_job_env(workflow, job);
            Some(PlannedJob {
                id: job.id.clone(),
                display_name: job.name.clone().unwrap_or_else(|| job.id.clone()),
                runner_name: expanded.runner_name,
                target: planned_job_target(job),
                needs: job.needs.clone(),
                if_condition: job.if_condition.clone(),
                outputs: job.outputs.clone(),
                services: planned_services(job),
                container: planned_container(job),
                steps: planned_steps(workflow, job, &env),
                step_count: job.steps.len(),
                env,
                matrix_context: expanded.matrix_context,
            })
        })
        .collect::<Vec<_>>();

    let schedule = schedule_job_waves(&jobs);

    WorkflowRunPlan {
        workflow_path: workflow.path.clone(),
        diagnostics,
        jobs,
        schedule,
    }
}

fn merged_job_env(workflow: &WorkflowDocument, job: &WorkflowJob) -> BTreeMap<String, String> {
    let mut env = workflow.env.clone();
    env.extend(job.env.clone());
    env
}

fn planned_container(job: &WorkflowJob) -> Option<DtuJobContainer> {
    job.container.as_ref().map(|container| DtuJobContainer {
        image: container.image.clone(),
        env: container.env.clone(),
        ports: container.ports.clone(),
        volumes: container.volumes.clone(),
        options: container.options.clone(),
    })
}

fn planned_services(job: &WorkflowJob) -> Vec<ServiceSpec> {
    job.services
        .values()
        .map(|service| ServiceSpec {
            id: service.id.clone(),
            image: service.image.clone(),
            env: service
                .env
                .iter()
                .map(|(key, value)| format!("{key}={value}"))
                .collect(),
            ports: service.ports.clone(),
            options: service.options.clone(),
            health_cmd: None,
        })
        .collect()
}

fn planned_steps(
    workflow: &WorkflowDocument,
    job: &WorkflowJob,
    job_env: &BTreeMap<String, String>,
) -> Vec<PlannedStep> {
    job.steps
        .iter()
        .enumerate()
        .map(|(index, step)| {
            let mut env = job_env.clone();
            env.extend(step.env.clone());
            PlannedStep {
                id: step.id.clone(),
                name: planned_step_name(step, index),
                index: index + 1,
                run: step.run.clone(),
                uses: step.uses.clone(),
                if_condition: step.if_condition.clone(),
                shell: effective_run_default(workflow, job, step, "shell"),
                working_directory: effective_run_default(workflow, job, step, "working-directory"),
                env,
                with: step.with.clone(),
            }
        })
        .collect()
}

fn effective_run_default(
    workflow: &WorkflowDocument,
    job: &WorkflowJob,
    step: &WorkflowStep,
    key: &str,
) -> Option<String> {
    let step_value = match key {
        "shell" => step.shell.clone(),
        "working-directory" => step.working_directory.clone(),
        _ => None,
    };

    step_value
        .or_else(|| run_default_from_value(&job.raw, key))
        .or_else(|| run_default_from_value(&workflow.raw, key))
}

fn run_default_from_value(source: &serde_yaml::Value, key: &str) -> Option<String> {
    let defaults = mapping_value(source, "defaults")?;
    let run = mapping_value(defaults, "run")?;
    mapping_value(run, key)
        .and_then(serde_yaml::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn mapping_value<'a>(source: &'a serde_yaml::Value, key: &str) -> Option<&'a serde_yaml::Value> {
    source
        .as_mapping()?
        .get(serde_yaml::Value::String(key.to_owned()))
}

fn planned_step_name(step: &WorkflowStep, index: usize) -> String {
    step.name
        .clone()
        .or_else(|| step.id.clone())
        .or_else(|| step.uses.clone())
        .or_else(|| {
            step.run
                .as_ref()
                .and_then(|run| run.lines().next().map(str::to_owned))
        })
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("Step {}", index + 1))
}

fn planned_job_target(job: &WorkflowJob) -> PlannedJobTarget {
    if let Some(uses) = &job.uses {
        return PlannedJobTarget::ReusableWorkflow { uses: uses.clone() };
    }

    let Some(runs_on) = job.runs_on.as_ref().map(format_runs_on) else {
        return PlannedJobTarget::Unknown;
    };

    if runs_on.to_ascii_lowercase().contains("macos") {
        PlannedJobTarget::MacOs { runs_on }
    } else {
        PlannedJobTarget::Linux { runs_on }
    }
}

pub fn runner_execution_plan_for_job(
    workflow: &WorkflowRunPlan,
    job: &PlannedJob,
    image: impl Into<String>,
    log_dir: PathBuf,
    signals_dir: PathBuf,
    pause_on_failure: bool,
) -> JobExecutionPlan {
    JobExecutionPlan {
        workflow: workflow
            .workflow_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("workflow.yml")
            .to_owned(),
        job_id: job.id.clone(),
        runner_name: job.runner_name.clone(),
        container_name: if pause_on_failure {
            job.runner_name.clone()
        } else {
            format!("{}-{}", job.runner_name, std::process::id())
        },
        image: image.into(),
        env: Vec::new(),
        binds: Vec::new(),
        extra_hosts: Vec::new(),
        command: Vec::new(),
        log_dir,
        signals_dir,
        services: job.services.clone(),
        pause_on_failure,
    }
}

pub fn dtu_job_seed_for_planned_job(
    run_plan: &RunPlan,
    workflow: &WorkflowRunPlan,
    job: &PlannedJob,
    github_repo: impl Into<String>,
    needs_context: BTreeMap<String, NeedContext>,
) -> DtuJobSeed {
    let workflow_name = workflow
        .workflow_path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("workflow")
        .to_owned();
    let expression_context = expression_context_for_job(job, &needs_context, &run_plan.repo_root);
    DtuJobSeed {
        id: format!("{}-{}", workflow_name, job.runner_name),
        runner_name: job.runner_name.clone(),
        name: job.display_name.clone(),
        workflow_name,
        repo_root: run_plan.repo_root.clone(),
        github_repo: github_repo.into(),
        head_sha: run_plan
            .effective_sha
            .sha_ref
            .clone()
            .unwrap_or_else(|| run_plan.effective_sha.head_sha.clone()),
        real_head_sha: run_plan.effective_sha.head_sha.clone(),
        runner_work_dir: None,
        runner_os: None,
        runner_arch: None,
        env: job.env.clone(),
        outputs: job.outputs.clone(),
        needs_context,
        container: job.container.clone(),
        services: job.services.clone(),
        matrix_context: job.matrix_context.clone(),
        steps: job
            .steps
            .iter()
            .map(|step| {
                let step_expression_context =
                    expression_context_for_step(&expression_context, step);
                DtuJobStep {
                    name: expand_expressions(&step.name, &step_expression_context),
                    context_name: step.id.clone(),
                    run: step
                        .run
                        .as_ref()
                        .map(|run| expand_expressions(run, &step_expression_context)),
                    uses: step.uses.clone(),
                    shell: step.shell.clone(),
                    working_directory: step.working_directory.clone(),
                    condition: step.if_condition.clone(),
                    env: step_expression_context.env,
                    with: step.with.clone(),
                }
            })
            .collect(),
    }
}

fn expression_context_for_job(
    job: &PlannedJob,
    needs_context: &BTreeMap<String, NeedContext>,
    repo_root: &Path,
) -> ExpressionContext {
    let needs = needs_context
        .iter()
        .map(|(job_id, need)| {
            let mut values = need.outputs.clone();
            values.insert("__result".to_owned(), need.result.clone());
            (job_id.clone(), values)
        })
        .collect::<BTreeMap<_, _>>();
    let runner = match &job.target {
        PlannedJobTarget::MacOs { .. } => RunnerContext {
            os: "macOS".to_owned(),
            arch: "ARM64".to_owned(),
        },
        _ => RunnerContext::default(),
    };
    ExpressionContext {
        repo_path: Some(repo_root.to_path_buf()),
        matrix: job.matrix_context.clone().unwrap_or_default(),
        needs,
        runner,
        env: job.env.clone(),
        ..ExpressionContext::default()
    }
}

pub fn schedule_job_waves(jobs: &[PlannedJob]) -> Vec<Vec<String>> {
    let mut expanded_keys_by_job_id = std::collections::BTreeMap::<String, Vec<String>>::new();
    for job in jobs {
        expanded_keys_by_job_id
            .entry(job.id.clone())
            .or_default()
            .push(schedule_key(job));
    }

    let mut remaining = jobs
        .iter()
        .map(|job| {
            let dependencies = job
                .needs
                .iter()
                .flat_map(|need| {
                    expanded_keys_by_job_id
                        .get(need)
                        .cloned()
                        .unwrap_or_else(|| vec![need.clone()])
                })
                .collect::<Vec<_>>();
            (schedule_key(job), dependencies)
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    let mut completed = std::collections::BTreeSet::new();
    let mut waves = Vec::new();

    while !remaining.is_empty() {
        let wave = remaining
            .iter()
            .filter(|(_, needs)| needs.iter().all(|need| completed.contains(need)))
            .map(|(job_id, _)| job_id.clone())
            .collect::<Vec<_>>();

        if wave.is_empty() {
            waves.push(remaining.keys().cloned().collect());
            break;
        }

        for job_id in &wave {
            remaining.remove(job_id);
            completed.insert(job_id.clone());
        }
        waves.push(wave);
    }

    waves
}

fn schedule_key(job: &PlannedJob) -> String {
    if job.matrix_context.is_some() {
        job.runner_name.clone()
    } else {
        job.id.clone()
    }
}

pub fn execution_route_for_job(
    job: &PlannedJob,
    macos_capability: &HostCapability,
) -> JobExecutionRoute {
    match &job.target {
        PlannedJobTarget::Linux { .. } => JobExecutionRoute::Linux,
        PlannedJobTarget::MacOs { runs_on } => match macos_capability {
            HostCapability::Supported => JobExecutionRoute::MacOs,
            HostCapability::Unsupported { reason, hint } => JobExecutionRoute::Skip {
                reason: hint.as_ref().map_or_else(
                    || format!("{runs_on}: {reason}"),
                    |hint| format!("{runs_on}: {reason} {hint}"),
                ),
            },
        },
        PlannedJobTarget::ReusableWorkflow { uses } => JobExecutionRoute::Skip {
            reason: format!("reusable workflow job '{uses}' is expanded before execution"),
        },
        PlannedJobTarget::Unknown => JobExecutionRoute::Skip {
            reason: "unknown or unsupported runner target".to_owned(),
        },
    }
}

pub fn decide_job_run(
    job: &PlannedJob,
    completed_results: &std::collections::BTreeMap<String, JobResultStatus>,
) -> JobRunDecision {
    let needs_results = job
        .needs
        .iter()
        .map(|need| {
            (
                need.clone(),
                completed_results
                    .get(need)
                    .copied()
                    .unwrap_or(JobResultStatus::Skipped),
            )
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    let default_success = needs_results
        .values()
        .all(|result| *result == JobResultStatus::Success);

    let Some(condition) = job.if_condition.as_deref() else {
        return if default_success {
            JobRunDecision::Run
        } else {
            JobRunDecision::Skip {
                reason: "one or more needed jobs did not succeed".to_owned(),
            }
        };
    };

    let condition = normalize_job_if(condition);
    let status_function_present = contains_status_check_function(condition);
    let job_results = needs_results
        .iter()
        .map(|(job_id, result)| (job_id.clone(), result.as_github_result().to_owned()))
        .collect::<std::collections::BTreeMap<_, _>>();
    let needs_context = needs_results
        .iter()
        .map(|(job_id, result)| {
            let mut context = std::collections::BTreeMap::new();
            context.insert("__result".to_owned(), result.as_github_result().to_owned());
            (job_id.clone(), context)
        })
        .collect::<std::collections::BTreeMap<_, _>>();

    let condition_allows = evaluate_job_if(condition, &job_results, &needs_context);
    let should_run = if status_function_present {
        condition_allows
    } else {
        default_success && condition_allows
    };

    if should_run {
        JobRunDecision::Run
    } else {
        JobRunDecision::Skip {
            reason: format!("job condition evaluated to false: {condition}"),
        }
    }
}

fn expression_context_for_step(base: &ExpressionContext, step: &PlannedStep) -> ExpressionContext {
    let mut raw_env_context = base.clone();
    raw_env_context.env = step.env.clone();
    let env = step
        .env
        .iter()
        .map(|(key, value)| (key.clone(), expand_expressions(value, &raw_env_context)))
        .collect::<BTreeMap<_, _>>();

    let mut context = base.clone();
    context.env = env;
    context
}

fn current_macos_vm_host_capability() -> HostCapability {
    check_macos_vm_host(
        std::env::consts::OS,
        std::env::consts::ARCH,
        command_exists("tart"),
        command_exists("sshpass"),
    )
}

fn command_exists(command: &str) -> bool {
    Command::new("sh")
        .args(["-c", &format!("command -v {command} >/dev/null 2>&1")])
        .status()
        .is_ok_and(|status| status.success())
}

fn needs_context_for_job(
    job: &PlannedJob,
    completed_results: &BTreeMap<String, JobResultStatus>,
    completed_outputs: &BTreeMap<String, BTreeMap<String, String>>,
) -> BTreeMap<String, NeedContext> {
    job.needs
        .iter()
        .map(|need| {
            let result = completed_results
                .get(need)
                .copied()
                .unwrap_or(JobResultStatus::Skipped)
                .as_github_result()
                .to_owned();
            let outputs = completed_outputs.get(need).cloned().unwrap_or_default();
            (need.clone(), NeedContext { result, outputs })
        })
        .collect()
}

fn extract_static_step_outputs(job: &PlannedJob) -> BTreeMap<String, String> {
    let mut outputs = BTreeMap::new();
    for run in job.steps.iter().filter_map(|step| step.run.as_deref()) {
        for line in run.lines() {
            if let Some((key, value)) = parse_github_output_echo(line) {
                outputs.insert(key, value);
            }
        }
    }
    outputs
}

fn parse_github_output_echo(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    if !trimmed.contains("GITHUB_OUTPUT") {
        return None;
    }
    let (left, _) = trimmed.split_once(">>")?;
    let mut value = left.trim();
    value = value.strip_prefix("echo")?.trim();
    if let Some(rest) = value.strip_prefix("-e") {
        value = rest.trim();
    }
    value = value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .or_else(|| {
            value
                .strip_prefix('\'')
                .and_then(|value| value.strip_suffix('\''))
        })
        .unwrap_or(value)
        .trim();
    let (key, output_value) = value.split_once('=')?;
    let key = key.trim();
    if key.is_empty() {
        return None;
    }
    Some((key.to_owned(), output_value.to_owned()))
}

fn read_step_outputs(log_dir: &Path) -> BTreeMap<String, String> {
    fs::read_to_string(log_dir.join("outputs.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|value| value.as_object().cloned())
        .map(|object| {
            object
                .into_iter()
                .map(|(key, value)| (key, json_value_to_string(&value)))
                .collect()
        })
        .unwrap_or_default()
}

fn resolve_job_outputs(
    output_defs: &BTreeMap<String, String>,
    step_outputs: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    output_defs
        .iter()
        .map(|(name, template)| {
            (
                name.clone(),
                resolve_step_output_template(template, step_outputs),
            )
        })
        .collect()
}

fn resolve_step_output_template(template: &str, step_outputs: &BTreeMap<String, String>) -> String {
    let mut remaining = template;
    let mut out = String::new();
    while let Some(start) = remaining.find("${{") {
        out.push_str(&remaining[..start]);
        let after_start = &remaining[start + 3..];
        let Some(end) = after_start.find("}}") else {
            out.push_str(&remaining[start..]);
            return out;
        };
        let expr = after_start[..end].trim();
        out.push_str(&resolve_step_output_expr(expr, step_outputs));
        remaining = &after_start[end + 2..];
    }
    out.push_str(remaining);
    out
}

fn resolve_step_output_expr(expr: &str, step_outputs: &BTreeMap<String, String>) -> String {
    let parts = expr.split('.').collect::<Vec<_>>();
    if parts.len() == 4 && parts[0] == "steps" && parts[2] == "outputs" {
        return step_outputs.get(parts[3]).cloned().unwrap_or_default();
    }
    String::new()
}

fn json_value_to_string(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(value) => value.clone(),
        serde_json::Value::Bool(value) => value.to_string(),
        serde_json::Value::Number(value) => value.to_string(),
        serde_json::Value::Null => String::new(),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
            serde_json::to_string(value).unwrap_or_default()
        }
    }
}

fn normalize_job_if(condition: &str) -> &str {
    let trimmed = condition.trim();
    trimmed
        .strip_prefix("${{")
        .and_then(|value| value.strip_suffix("}}"))
        .map(str::trim)
        .unwrap_or(trimmed)
}

fn contains_status_check_function(condition: &str) -> bool {
    ["success()", "failure()", "always()", "cancelled()"]
        .iter()
        .any(|function| condition.contains(function))
}

fn write_plan_summary(plan: &RunPlan, stdout: &mut impl Write) {
    match &plan.selection {
        RunSelection::SingleWorkflow => {
            let Some(workflow) = plan.workflows.first() else {
                return;
            };
            let job_count = workflow.jobs.len();
            let _ = writeln!(
                stdout,
                "[Agent CI] Discovered {job_count} job(s) in {} at {}.",
                workflow.workflow_path.display(),
                plan.effective_sha.head_sha
            );
            for job in &workflow.jobs {
                let target = format_planned_target(&job.target);
                let _ = writeln!(stdout, "  - {} ({target})", job.id);
            }
        }
        RunSelection::AllRelevant { branch, .. } => {
            let _ = writeln!(
                stdout,
                "[Agent CI] Discovered {} relevant workflow(s) for branch '{}'.",
                plan.workflows.len(),
                branch
            );
            for workflow in &plan.workflows {
                let _ = writeln!(stdout, "  - {}", workflow.workflow_path.display());
            }
        }
    }
}

fn print_human_summary(
    results: &[JobResult],
    run_dir: Option<&Path>,
    repo_root: &Path,
    working_dir: &Path,
    env: &BTreeMap<String, String>,
    stdout: &mut impl Write,
) {
    let failures = results
        .iter()
        .filter(|result| !result.succeeded)
        .collect::<Vec<_>>();
    let passes = results
        .iter()
        .filter(|result| result.succeeded)
        .collect::<Vec<_>>();
    let total_ms = results.iter().map(|result| result.duration_ms).sum::<u64>();

    if !failures.is_empty() {
        let _ = writeln!(
            stdout,
            "\n━━━ FAILURES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        );
        let mut groups = Vec::<(String, Vec<&JobResult>)>::new();
        for failure in failures {
            let content = failure_content(failure);
            if let Some((_, failures)) =
                groups.iter_mut().find(|(existing, _)| *existing == content)
            {
                failures.push(failure);
            } else {
                groups.push((content, vec![failure]));
            }
        }
        for (content, failures) in groups {
            for failure in &failures {
                if let Some(step) = &failure.failed_step {
                    let _ = writeln!(
                        stdout,
                        "  ✗ {} > {} > \"{}\"",
                        failure.workflow, failure.name, step
                    );
                } else {
                    let _ = writeln!(stdout, "  ✗ {} > {}", failure.workflow, failure.name);
                }
            }
            if !content.is_empty() {
                let _ = writeln!(stdout, "\n{}", content.trim_end());
            }
            if let Some(hint) = failure_hint(&content, repo_root, working_dir, env) {
                let _ = writeln!(stdout, "\n{hint}");
            }
            let _ = writeln!(stdout);
        }
    }

    let _ = writeln!(
        stdout,
        "\n━━━ SUMMARY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    );
    let status = if results.iter().any(|result| !result.succeeded) {
        format!(
            "✗ {} failed, {} passed",
            results.len() - passes.len(),
            passes.len()
        )
    } else {
        format!("✓ {} passed", passes.len())
    };
    let _ = writeln!(stdout, "  Status:    {status} ({} total)", results.len());
    let _ = writeln!(stdout, "  Duration:  {}", format_duration(total_ms));
    if let Some(run_dir) = run_dir {
        let _ = writeln!(stdout, "  Root:      {}", run_dir.display());
    }
    let _ = writeln!(stdout);
}

fn failure_content(result: &JobResult) -> String {
    if let Some(failed_step) = &result.failed_step
        && let Some(path) = result
            .steps
            .iter()
            .find(|step| step.name == *failed_step)
            .and_then(|step| step.log_path.as_ref())
        && let Ok(content) = fs::read_to_string(path)
    {
        return content;
    }
    result
        .debug_log_path
        .as_ref()
        .and_then(|path| tail_log_file(path, 20))
        .unwrap_or_default()
}

fn tail_log_file(path: &Path, line_count: usize) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    let mut lines = content.lines().map(ToOwned::to_owned).collect::<Vec<_>>();
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
    let start = lines.len().saturating_sub(line_count);
    Some(format!("{}\n", lines[start..].join("\n")))
}

fn failure_hint(
    content: &str,
    repo_root: &Path,
    working_dir: &Path,
    env: &BTreeMap<String, String>,
) -> Option<String> {
    detect_toolcache_hint(content, &working_dir.join("cache/toolcache"))
        .or_else(|| detect_missing_tool_hint(content, repo_root, env))
}

fn detect_missing_tool_hint(
    content: &str,
    repo_root: &Path,
    env: &BTreeMap<String, String>,
) -> Option<String> {
    if env
        .get("AGENT_CI_RUNNER_IMAGE")
        .is_some_and(|value| !value.trim().is_empty())
        || repo_root.join(".github/agent-ci/Dockerfile").exists()
        || repo_root.join(".github/agent-ci.Dockerfile").exists()
    {
        return None;
    }
    let tool = missing_tool_name(content)?;
    Some(format!(
        "Hint: `{tool}` is not in agent-ci's default runner image.\n\nThe default image (ghcr.io/actions/actions-runner:latest) is a minimal\ncontainer and does not ship system build tools — unlike GitHub's hosted\nubuntu-latest, which is a full VM image that is not published as a\ncontainer and cannot be pulled.\n\nTo fix this, create a .github/agent-ci.Dockerfile in your repo that\ninstalls the missing tool. See the runner image docs for recipes:\nhttps://github.com/redwoodjs/agent-ci/blob/main/packages/cli/runner-image.md"
    ))
}

fn missing_tool_name(content: &str) -> Option<String> {
    for line in content.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.contains("command not found") || lower.contains(": not found") {
            let idx = lower
                .find("command not found")
                .or_else(|| lower.find("not found"))?;
            let before_not_found = line.get(..idx).unwrap_or(line);
            let before_colon = before_not_found
                .rsplit(':')
                .map(str::trim)
                .find(|part| !part.is_empty())?;
            let tool = before_colon.split_whitespace().last()?.trim_matches('`');
            if !tool.is_empty() {
                return Some(tool.to_owned());
            }
        }
        if let Some(tool) = lower
            .split("you do not have '")
            .nth(1)
            .and_then(|rest| rest.split('\'').next())
            .filter(|tool| !tool.is_empty())
        {
            return Some(tool.to_owned());
        }
    }
    None
}

fn detect_toolcache_hint(content: &str, tool_cache_dir: &Path) -> Option<String> {
    (content.contains("tar:") && content.contains("Cannot open: Permission denied")).then(|| {
        format!(
            "Hint: extraction under /opt/hostedtoolcache failed because files from a\nprevious run are owned by a user this run can't overwrite. Delete the\nhost-side toolcache and re-run:\n\n    sudo rm -rf '{}'",
            tool_cache_dir.display()
        )
    })
}

fn format_duration(ms: u64) -> String {
    let seconds = (ms + 500) / 1000;
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    let remaining = seconds % 60;
    if remaining > 0 {
        format!("{minutes}m {remaining}s")
    } else {
        format!("{minutes}m")
    }
}

fn execute_run_plan(
    plan: &RunPlan,
    stdout: &mut impl Write,
    stderr: &mut impl Write,
    json_mode: bool,
) -> i32 {
    match execute_run_plan_inner(plan, stdout, stderr, json_mode) {
        Ok(status) => status,
        Err(err) => {
            let _ = writeln!(stderr, "[Agent CI] Error: {err}");
            1
        }
    }
}

fn execute_run_plan_inner(
    plan: &RunPlan,
    stdout: &mut impl Write,
    stderr: &mut impl Write,
    json_mode: bool,
) -> Result<i32, String> {
    let started_at = event_timestamp();
    let process_env = std::env::vars().collect::<BTreeMap<_, _>>();
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let state_env = StateDirEnv::from_env(&process_env);
    let state_dir = resolve_state_dir(&state_env, std::env::consts::OS, &home);
    let logs_dir = resolve_logs_dir(&state_env, std::env::consts::OS, &home);
    let working_dir = default_working_dir(&plan.repo_root);
    fs::create_dir_all(&working_dir).map_err(|err| err.to_string())?;
    fs::create_dir_all(&logs_dir).map_err(|err| err.to_string())?;

    let dtu_host = resolve_dtu_host(&process_env);
    let mut dtu = Some(
        start_ephemeral_dtu(working_dir.join("cache/dtu"), Some(&dtu_host))
            .map_err(|err| format!("failed to start DTU: {err}"))?,
    );
    let dtu_ref = dtu.as_ref().expect("DTU just started");
    let dtu_url = dtu_ref.url.clone();
    let dtu_container_url = dtu_ref.container_url.clone();
    let dtu_port = dtu_ref.port.to_string();
    let docker_api_url = resolve_docker_api_url(&dtu_url, &dtu_host);

    let github_repo = resolve_github_repo(&plan.repo_root);
    let repo_url = format!("{docker_api_url}/{github_repo}");
    let branch = run_result_branch(plan);
    let mut docker_runtime = DockerCliRuntime::default();
    let mut image: Option<String> = None;
    let mut docker_socket = None;
    let mut extra_hosts = None;
    let macos_capability = current_macos_vm_host_capability();

    let mut completed_results = BTreeMap::<String, JobResultStatus>::new();
    let mut completed_outputs = BTreeMap::<String, BTreeMap<String, String>>::new();
    let mut job_results = Vec::<JobResult>::new();
    let mut any_failed = false;

    for workflow in &plan.workflows {
        for wave in &workflow.schedule {
            for scheduled in wave {
                let Some(job) = workflow
                    .jobs
                    .iter()
                    .find(|job| planned_job_schedule_key(job) == *scheduled)
                else {
                    continue;
                };
                match decide_job_run(job, &completed_results) {
                    JobRunDecision::Run => {}
                    JobRunDecision::Skip { .. } => {
                        completed_results.insert(job.id.clone(), JobResultStatus::Skipped);
                        continue;
                    }
                }

                match execution_route_for_job(job, &macos_capability) {
                    JobExecutionRoute::Linux => {}
                    JobExecutionRoute::MacOs => {
                        let result = execute_macos_planned_job(MacosExecutionContext {
                            run_plan: plan,
                            workflow,
                            job,
                            working_dir: &working_dir,
                            logs_dir: &logs_dir,
                            process_env: &process_env,
                            github_repo: &github_repo,
                            dtu_url: &dtu_url,
                            dtu_port: &dtu_port,
                            stderr,
                        })?;
                        any_failed |= !result.succeeded;
                        let status = if result.succeeded {
                            JobResultStatus::Success
                        } else {
                            JobResultStatus::Failure
                        };
                        let mut step_outputs = read_step_outputs(
                            result
                                .debug_log_path
                                .as_deref()
                                .and_then(Path::parent)
                                .unwrap_or_else(|| Path::new(".")),
                        );
                        step_outputs.extend(extract_static_step_outputs(job));
                        completed_outputs.insert(
                            job.id.clone(),
                            resolve_job_outputs(&job.outputs, &step_outputs),
                        );
                        completed_results.insert(job.id.clone(), status);
                        job_results.push(result);
                        continue;
                    }
                    JobExecutionRoute::Skip { reason } => {
                        let _ = writeln!(
                            stderr,
                            "[Agent CI] Skipping '{}': {reason}",
                            job.display_name
                        );
                        completed_results.insert(job.id.clone(), JobResultStatus::Skipped);
                        continue;
                    }
                }

                if image.is_none() {
                    let resolved = discover_runner_image(
                        &plan.repo_root,
                        process_env.get("AGENT_CI_RUNNER_IMAGE").map(String::as_str),
                    );
                    image = Some(ensure_runner_image(&mut docker_runtime, &resolved)?);
                }
                if docker_socket.is_none() {
                    docker_socket =
                        Some(resolve_docker_socket(&DockerSocketProbe::from_process())?);
                }
                if extra_hosts.is_none() {
                    extra_hosts = Some(
                        resolve_docker_extra_hosts(&process_env, &dtu_host).unwrap_or_default(),
                    );
                }
                let image = image.clone().expect("runner image initialized");
                let docker_socket = docker_socket.as_ref().expect("docker socket initialized");
                let extra_hosts = extra_hosts.as_ref().expect("extra hosts initialized");

                let log_context =
                    create_log_context(&working_dir, &logs_dir, "agent-ci", Some(&job.runner_name))
                        .map_err(|err| err.to_string())?;
                let dirs =
                    create_rust_run_directories(&working_dir, &log_context.run_dir, &github_repo)?;
                write_git_shim(&dirs.shims_dir, &plan.effective_sha.head_sha)?;
                sync_worktree_to_workspace(&plan.repo_root, &dirs.workspace_dir)?;
                init_fake_git_repo(&dirs.workspace_dir, &github_repo)?;
                chmod_tree_best_effort(&dirs.container_work_dir);
                chmod_tree_best_effort(&dirs.diag_dir);

                let runner_work_dir_override = if job.container.is_some() {
                    ensure_docker_vm_runner_externals(&image)?;
                    Some(prepare_docker_vm_work_dir(&dirs.container_work_dir)?)
                } else {
                    None
                };
                let runner_work_dir = runner_work_dir_override
                    .as_deref()
                    .map(str::to_owned)
                    .unwrap_or_else(|| dirs.container_work_dir.to_string_lossy().into_owned());

                let mut execution_plan = runner_execution_plan_for_job(
                    workflow,
                    job,
                    image.clone(),
                    log_context.log_dir.clone(),
                    dirs.signals_dir.clone(),
                    plan.pause_on_failure,
                );
                if job.container.is_some() {
                    execution_plan.services.clear();
                }
                execution_plan.env = build_container_env(&ContainerEnvOpts {
                    container_name: job.runner_name.clone(),
                    registration_token: "mock-registration-token".to_owned(),
                    repo_url: repo_url.clone(),
                    docker_api_url: docker_api_url.clone(),
                    github_repo: github_repo.clone(),
                    head_sha: Some(plan.effective_sha.head_sha.clone()),
                    dtu_host: dtu_host.clone(),
                    use_direct_container: false,
                });
                execution_plan.binds = build_container_binds(&ContainerBindsOpts {
                    host_work_dir: runner_work_dir.clone(),
                    shims_dir: dirs.shims_dir.to_string_lossy().into_owned(),
                    signals_dir: plan
                        .pause_on_failure
                        .then(|| dirs.signals_dir.to_string_lossy().into_owned()),
                    diag_dir: dirs.diag_dir.to_string_lossy().into_owned(),
                    tool_cache_dir: dirs.tool_cache_dir.to_string_lossy().into_owned(),
                    pnpm_store_dir: Some(dirs.pnpm_store_dir.to_string_lossy().into_owned()),
                    npm_cache_dir: Some(dirs.npm_cache_dir.to_string_lossy().into_owned()),
                    yarn_cache_dir: Some(dirs.yarn_cache_dir.to_string_lossy().into_owned()),
                    bun_cache_dir: Some(dirs.bun_cache_dir.to_string_lossy().into_owned()),
                    playwright_cache_dir: dirs.playwright_cache_dir.to_string_lossy().into_owned(),
                    cypress_cache_dir: Some(dirs.cypress_cache_dir.to_string_lossy().into_owned()),
                    warm_modules_dir: dirs.warm_modules_dir.to_string_lossy().into_owned(),
                    host_runner_dir: dirs.host_runner_dir.to_string_lossy().into_owned(),
                    use_direct_container: false,
                    github_repo: github_repo.clone(),
                    docker_socket_path: (!docker_socket.bind_mount_path.is_empty())
                        .then_some(docker_socket.bind_mount_path.clone()),
                });
                execution_plan.extra_hosts = extra_hosts.clone();
                execution_plan.command = build_container_cmd(&ContainerCmdOpts {
                    dtu_port: dtu_port.clone(),
                    dtu_host: dtu_host.clone(),
                    use_direct_container: false,
                    container_name: job.runner_name.clone(),
                });

                let mut seed = dtu_job_seed_for_planned_job(
                    plan,
                    workflow,
                    job,
                    github_repo.clone(),
                    needs_context_for_job(job, &completed_results, &completed_outputs),
                );
                if plan.pause_on_failure && job.container.is_none() {
                    wrap_pause_on_failure_steps(&mut seed.steps);
                }
                if let Some(runner_work_dir) = &runner_work_dir_override {
                    seed.runner_work_dir = Some(PathBuf::from(runner_work_dir));
                }
                let mut dtu_client = DtuHttpClient::new(&dtu_url);
                let _ = writeln!(
                    stderr,
                    "[Agent CI] Starting runner {} ({} > {})",
                    job.runner_name,
                    workflow
                        .workflow_path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("workflow.yml"),
                    job.display_name
                );
                let _ = writeln!(stderr, "  Logs: {}", execution_plan.log_dir.display());
                let _ = writeln!(stderr, "  DTU: {dtu_container_url}");

                let workflow_file = workflow
                    .workflow_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("workflow.yml")
                    .to_owned();
                let mut on_pause = |signal: PausedSignal| {
                    emit_pause_event(
                        stdout,
                        stderr,
                        json_mode,
                        &job.runner_name,
                        &job.display_name,
                        &workflow_file,
                        signal,
                    );
                };
                let result = execute_registered_runner_job_with_pause_observer(
                    &mut dtu_client,
                    &mut docker_runtime,
                    &execution_plan,
                    &seed,
                    &mut on_pause,
                )?;
                any_failed |= !result.succeeded;
                let status = if result.succeeded {
                    JobResultStatus::Success
                } else {
                    JobResultStatus::Failure
                };
                let mut step_outputs = read_step_outputs(&execution_plan.log_dir);
                step_outputs.extend(extract_static_step_outputs(job));
                completed_outputs.insert(
                    job.id.clone(),
                    resolve_job_outputs(&job.outputs, &step_outputs),
                );
                completed_results.insert(job.id.clone(), status);
                job_results.push(result);
            }
        }
    }

    if !json_mode {
        print_human_summary(
            &job_results,
            Some(&working_dir),
            &plan.repo_root,
            &working_dir,
            &process_env,
            stdout,
        );
    }

    let finished_at = event_timestamp();
    let _ = write_run_result(
        &RunResultInput {
            repo: github_repo,
            branch,
            worktree_path: plan.repo_root.clone(),
            head_sha: plan.effective_sha.head_sha.clone(),
            started_at,
            finished_at,
            results: job_results.iter().map(job_result_input).collect(),
        },
        Some(&state_dir),
    );

    if let Some(dtu) = dtu.take() {
        dtu.close();
    }
    Ok(if any_failed { 1 } else { 0 })
}

struct MacosExecutionContext<'a, W: Write> {
    run_plan: &'a RunPlan,
    workflow: &'a WorkflowRunPlan,
    job: &'a PlannedJob,
    working_dir: &'a Path,
    logs_dir: &'a Path,
    process_env: &'a BTreeMap<String, String>,
    github_repo: &'a str,
    dtu_url: &'a str,
    dtu_port: &'a str,
    stderr: &'a mut W,
}

fn execute_macos_planned_job(
    ctx: MacosExecutionContext<'_, impl Write>,
) -> Result<JobResult, String> {
    let run_plan = ctx.run_plan;
    let workflow = ctx.workflow;
    let job = ctx.job;
    let working_dir = ctx.working_dir;
    let logs_dir = ctx.logs_dir;
    let process_env = ctx.process_env;
    let github_repo = ctx.github_repo;
    let dtu_url = ctx.dtu_url;
    let dtu_port = ctx.dtu_port;
    let stderr = ctx.stderr;
    let log_context = create_log_context(
        working_dir,
        logs_dir,
        "agent-ci-macos",
        Some(&job.runner_name),
    )
    .map_err(|err| err.to_string())?;
    let labels = macos_labels_for_job(job);
    let image_resolution = resolve_macos_vm_image(
        &labels,
        process_env
            .get("AGENT_CI_MACOS_VM_IMAGE")
            .map(String::as_str),
    );
    if !image_resolution.exact {
        let _ = writeln!(
            stderr,
            "[Agent CI] warning: could not map runs-on {:?} to a known macOS image; falling back to {}",
            labels, image_resolution.image
        );
    }

    let remote_runner_dir = process_env
        .get("AGENT_CI_MACOS_VM_RUNNER_DIR")
        .cloned()
        .unwrap_or_else(|| "/Users/admin/agent-ci-runner".to_owned());
    let remote_work_dir = format!("{remote_runner_dir}/_work");
    let repo_name = github_repo.split('/').next_back().unwrap_or("repo");
    let remote_workspace = format!("{remote_work_dir}/{repo_name}/{repo_name}");
    let remote_log_dir = format!("/Users/admin/agent-ci-logs/{}", job.runner_name);
    let vm_host_ip = process_env
        .get("AGENT_CI_MACOS_VM_HOST_IP")
        .map(String::as_str)
        .unwrap_or("192.168.64.1");
    let dtu_vm_url = format!("http://{vm_host_ip}:{dtu_port}/{github_repo}");
    let creds = SshCreds {
        user: process_env
            .get("AGENT_CI_MACOS_VM_USER")
            .cloned()
            .unwrap_or_else(|| "admin".to_owned()),
        password: process_env
            .get("AGENT_CI_MACOS_VM_PASSWORD")
            .cloned()
            .unwrap_or_else(|| "admin".to_owned()),
    };

    let version = resolve_macos_runner_version(
        process_env
            .get("AGENT_CI_MACOS_RUNNER_VERSION")
            .map(String::as_str),
    );
    let mut binary_io = CommandRunnerBinaryIo;
    let cached_runner = ensure_macos_runner_binary(
        &mut binary_io,
        &working_dir.join("cache/macos-runner"),
        &version,
    )?;
    let local_runner_dir = log_context.run_dir.join("macos-runner");
    prepare_local_macos_runner_dir(
        &cached_runner.dir,
        &local_runner_dir,
        &job.runner_name,
        &dtu_vm_url,
    )?;

    let mut seed =
        dtu_job_seed_for_planned_job(run_plan, workflow, job, github_repo, BTreeMap::new());
    seed.runner_work_dir = Some(PathBuf::from(&remote_work_dir));
    seed.runner_os = Some("macOS".to_owned());
    seed.runner_arch = Some("ARM64".to_owned());
    let mut dtu_client = DtuHttpClient::new(dtu_url);
    dtu_client.register_runner(&DtuRunnerRegistration {
        runner_name: job.runner_name.clone(),
        log_dir: log_context.log_dir.clone(),
        timeline_dir: log_context.log_dir.clone(),
        virtual_cache_patterns: Vec::new(),
    })?;
    dtu_client.seed_job(&seed)?;

    let _ = writeln!(
        stderr,
        "[Agent CI] Starting macOS VM runner {} ({} > {})",
        job.runner_name,
        workflow
            .workflow_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("workflow.yml"),
        job.display_name
    );
    let _ = writeln!(stderr, "  Logs: {}", log_context.log_dir.display());

    let vm_plan = MacosVmJobPlan {
        vm_name: job.runner_name.clone(),
        image: image_resolution.image,
        repo_root: run_plan.repo_root.clone(),
        local_runner_dir,
        remote_workspace,
        remote_runner_dir: remote_runner_dir.clone(),
        remote_log_dir,
        local_log_dir: log_context.log_dir.clone(),
        creds,
        dtu_url: dtu_vm_url,
        runner_token: "mock-registration-token".to_owned(),
        runner_labels: labels,
        job_script: format!("cd {remote_runner_dir} && ./run.sh --once"),
    };
    let started = Instant::now();
    let vm_result = execute_macos_vm_job(&mut CommandMacosVmRuntime::new(), &vm_plan)?;
    let duration_ms = started.elapsed().as_millis() as u64;
    let _ = fs::write(
        &log_context.debug_log_path,
        format!("{}{}", vm_result.stdout, vm_result.stderr),
    );
    let steps = parse_timeline_steps(&log_context.log_dir.join("timeline.json"));
    let timeline_failed = steps.iter().any(|step| step.status == StepStatus::Failed);
    let succeeded = vm_result.code == 0 && !timeline_failed && !steps.is_empty();
    let failed_step = steps
        .iter()
        .find(|step| step.status == StepStatus::Failed)
        .map(|step| step.name.clone())
        .or_else(|| (!succeeded).then(|| "unknown".to_owned()));

    Ok(JobResult {
        name: job.id.clone(),
        workflow: workflow
            .workflow_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("workflow.yml")
            .to_owned(),
        succeeded,
        paused: false,
        duration_ms,
        failed_step,
        debug_log_path: Some(log_context.debug_log_path),
        steps,
    })
}

fn prepare_local_macos_runner_dir(
    cached_runner_dir: &Path,
    local_runner_dir: &Path,
    runner_name: &str,
    repo_url: &str,
) -> Result<(), String> {
    let _ = fs::remove_dir_all(local_runner_dir);
    copy_dir_recursive(cached_runner_dir, local_runner_dir)?;
    write_macos_runner_credentials(local_runner_dir, runner_name, repo_url)
}

fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|err| err.to_string())?;
    for entry in fs::read_dir(source).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry.file_type().map_err(|err| err.to_string())?;
        if file_type.is_dir() {
            copy_dir_recursive(&source_path, &destination_path)?;
        } else if file_type.is_symlink() {
            copy_symlink_or_target(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &destination_path).map_err(|err| err.to_string())?;
            chmod_best_effort(&destination_path);
        }
    }
    chmod_best_effort(destination);
    Ok(())
}

fn copy_symlink_or_target(source: &Path, destination: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(
            fs::read_link(source).map_err(|err| err.to_string())?,
            destination,
        )
        .map_err(|err| err.to_string())?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        fs::copy(source, destination).map_err(|err| err.to_string())?;
        chmod_best_effort(destination);
        Ok(())
    }
}

fn write_macos_runner_credentials(
    runner_dir: &Path,
    runner_name: &str,
    repo_url: &str,
) -> Result<(), String> {
    let server_url = url_origin(repo_url).unwrap_or_else(|| repo_url.to_owned());
    let runner = serde_json::json!({
        "agentId": 1,
        "agentName": runner_name,
        "poolId": 1,
        "poolName": "Default",
        "serverUrl": server_url,
        "gitHubUrl": repo_url,
        "workFolder": "_work",
        "ephemeral": true,
    });
    let credentials = serde_json::json!({
        "scheme": "OAuth",
        "data": {
            "clientId": "00000000-0000-0000-0000-000000000000",
            "authorizationUrl": format!("{repo_url}/_apis/oauth2/token"),
            "oAuthEndpointUrl": format!("{repo_url}/_apis/oauth2/token"),
            "requireFipsCryptography": "False",
        }
    });
    let rsa_params = serde_json::json!({
        "d": "CQpCI+sO2GD1N/JsHHI9zEhMlu5Fcc8mU4O2bO6iscOsagFjvEnTesJgydC/Go1HuOBlx+GT9EG2h7+juS0z2o5n8Mvt5BBxlK+tqoDOs8VfQ9CSUl3hqYRPeNdBfnA1w8ovLW0wqfPO08FWTLI0urYsnwjZ5BQrBM+D7zYeA0aCsKdo75bKmaEKnmqrtIEhb7hE45XQa32Yt0RPCPi8QcQAY2HLHbdWdZYDj6k/UuDvz9H/xlDzwYq6Yikk2RSMArFzaufxCGS9tBZNEACDPYgnZnEMXRcvsnZ9FYbq81KOSifCmq7Yocq+j3rY5zJCD+PIDY9QJwPxB4PGasRKAQ==",
        "dp": "A0sY1oOz1+3uUMiy+I5xGuHGHOrEQPYspd1xGClBYYsa/Za0UDWS7V0Tn1cbRWfWtNe5vTpxcvwQd6UZBwrtHF6R2zyXFhE++PLPhCe0tH4C5FY9i9jUw9Vo8t44i/s5JUHU2B1mEptXFUA0GcVrLKS8toZSgqELSS2Q/YLRxoE=",
        "dq": "GrLC9dPJ5n3VYw51ghCH7tybUN9/Oe4T8d9v4dLQ34RQEWHwRd4g3U3zkvuhpXFPloUTMmkxS7MF5pS1evrtzkay4QUTDv+28s0xRuAsw5qNTzuFygg8t93MvpvTVZ2TNApW6C7NFvkL9NbxAnU8+I61/3ow7i6a7oYJJ0hWAxE=",
        "exponent": "AQAB",
        "inverseQ": "8DVz9FSvEdt5W4B9OjgakZHwGfnhn2VLDUxrsR5ilC5tPC/IgA8C2xEfKQM1t+K/N3pAYHBYQ6EPgtW4kquBS/Sy102xbRI7GSCnUbRtTpWYPOaCn6EaxBNzwWzbp5vCbCGvFqlSu4+OBYRVe+iCj+gAnkmT/TKPhHHbTjJHvw==",
        "modulus": "x0eoW2DD7xsW5YiorMN8pNHVvZk4ED1SHlA/bmVnRz5FjEDnQloMn0nBgIUHxoNArksknrp/FOVJv5sJHJTiRZkOp+ZmH7d3W3gmw63IxK2C5pV+6xfav9jR2+Wt/6FMYMgG2utBdF95oif1f2XREFovHoXkWms2l0CPLLHVPO44Hh9EEmBmjOeMJEZkulHJ44z9y8e+GZ2nYqO0ZiRWQcRObZ0vlRaGg6PPOl4ltay0BfNksMB3NDtlhkdVkAEFQxEaZZDK9NtkvNljXCioP3TyTAbqNUGsYCA5D+IHGZT9An99J9vUqTFP6TKjqUvy9WNiIzaUksCySA0a4SVBkQ==",
        "p": "8fgAdmWy+sTzAN19fYkWMQqeC7t1BCQMo5z5knfVLg8TtwP9ZGqDtoe+r0bGv3UgVsvvDdP/QwRvRVP+5G9l999Y6b4VbSdUbrfPfOgjpPDmRTQzHDve5jh5xBENQoRXYm7PMgHGmjwuFsE/tKtSGTrvt2Z3qcYAo0IOqLLhYmE=",
        "q": "0tXx4+P7gUWePf92UJLkzhNBClvdnmDbIt52Lui7YCARczbN/asCDJxcMy6Bh3qmIx/bNuOUrfzHkYZHfnRw8AGEK80qmiLLPI6jrUBOGRajmzemGQx0W8FWalEQfGdNIv9R2nsegDRoMq255Zo/qX60xQ6abpp0c6UNhVYSjTE=",
    });
    fs::write(
        runner_dir.join(".runner"),
        serde_json::to_vec_pretty(&runner).map_err(|err| err.to_string())?,
    )
    .map_err(|err| err.to_string())?;
    fs::write(
        runner_dir.join(".credentials"),
        serde_json::to_vec_pretty(&credentials).map_err(|err| err.to_string())?,
    )
    .map_err(|err| err.to_string())?;
    fs::write(
        runner_dir.join(".credentials_rsaparams"),
        serde_json::to_vec(&rsa_params).map_err(|err| err.to_string())?,
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn url_origin(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let authority = rest.split('/').next()?;
    Some(format!("{scheme}://{authority}"))
}

fn macos_labels_for_job(job: &PlannedJob) -> Vec<String> {
    match &job.target {
        PlannedJobTarget::MacOs { runs_on } => runs_on
            .split(',')
            .map(str::trim)
            .filter(|label| !label.is_empty())
            .map(ToOwned::to_owned)
            .collect(),
        _ => Vec::new(),
    }
}

#[derive(Debug, Clone)]
struct RustRunDirectories {
    container_work_dir: PathBuf,
    shims_dir: PathBuf,
    signals_dir: PathBuf,
    diag_dir: PathBuf,
    tool_cache_dir: PathBuf,
    pnpm_store_dir: PathBuf,
    npm_cache_dir: PathBuf,
    yarn_cache_dir: PathBuf,
    bun_cache_dir: PathBuf,
    playwright_cache_dir: PathBuf,
    cypress_cache_dir: PathBuf,
    warm_modules_dir: PathBuf,
    host_runner_dir: PathBuf,
    workspace_dir: PathBuf,
}

fn planned_job_schedule_key(job: &PlannedJob) -> String {
    if job.matrix_context.is_some() {
        job.runner_name.clone()
    } else {
        job.id.clone()
    }
}

fn default_working_dir(repo_root: &Path) -> PathBuf {
    if let Some(configured) = std::env::var_os("AGENT_CI_WORKING_DIR") {
        return PathBuf::from(configured);
    }
    let project_slug = repo_root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("repo");
    if Path::new("/.dockerenv").exists() {
        return repo_root.join(".agent-ci");
    }
    std::env::temp_dir().join("agent-ci").join(project_slug)
}

fn resolve_dtu_host(env: &BTreeMap<String, String>) -> String {
    let inside_docker = Path::new("/.dockerenv").exists();
    if !inside_docker {
        if let Some(configured) = env
            .get("AGENT_CI_DTU_HOST")
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
        {
            return configured.to_owned();
        }
        if let Some(configured) = env
            .get("AGENT_CI_DOCKER_BRIDGE_GATEWAY")
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
        {
            return configured.to_owned();
        }
        if let Some(host_ip) = discover_host_reachable_ip() {
            return host_ip;
        }
        return "host.docker.internal".to_owned();
    }

    let output = Command::new("sh")
        .arg("-lc")
        .arg("hostname -I 2>/dev/null | awk '{print $1}'")
        .output();
    output
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|value| !value.is_empty())
        .or_else(|| env.get("AGENT_CI_DOCKER_BRIDGE_GATEWAY").cloned())
        .unwrap_or_else(|| "172.17.0.1".to_owned())
}

fn discover_host_reachable_ip() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        for iface in ["en0", "en1", "bridge100"] {
            if let Some(ip) = command_stdout("ipconfig", &["getifaddr", iface]).and_then(first_ipv4)
            {
                return Some(ip);
            }
        }
    }

    command_stdout("hostname", &["-I"]).and_then(first_ipv4)
}

fn command_stdout(command: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(command).args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn first_ipv4(output: String) -> Option<String> {
    output
        .split_whitespace()
        .find(|part| {
            let octets = part.split('.').collect::<Vec<_>>();
            octets.len() == 4
                && *part != "127.0.0.1"
                && !part.starts_with("169.254.")
                && octets.iter().all(|octet| octet.parse::<u8>().is_ok())
        })
        .map(str::to_owned)
}

fn create_rust_run_directories(
    working_dir: &Path,
    run_dir: &Path,
    github_repo: &str,
) -> Result<RustRunDirectories, String> {
    let repo_slug = github_repo.replace('/', "-");
    let repo_name = github_repo.split('/').next_back().unwrap_or("repo");
    let container_work_dir = run_dir.join("work");
    let shims_dir = run_dir.join("shims");
    let signals_dir = run_dir.join("signals");
    let diag_dir = run_dir.join("diag");
    let tool_cache_dir = working_dir.join("cache/toolcache");
    let pnpm_store_dir = working_dir.join("cache/pnpm-store").join(&repo_slug);
    let npm_cache_dir = working_dir.join("cache/npm-cache").join(&repo_slug);
    let yarn_cache_dir = working_dir.join("cache/yarn-cache").join(&repo_slug);
    let bun_cache_dir = working_dir.join("cache/bun-cache").join(&repo_slug);
    let playwright_cache_dir = working_dir.join("cache/playwright").join(&repo_slug);
    let cypress_cache_dir = working_dir.join("cache/cypress").join(&repo_slug);
    let warm_modules_dir = working_dir
        .join("cache/warm-modules")
        .join(&repo_slug)
        .join("no-lockfile");
    let host_runner_dir = working_dir.join("runner");
    let workspace_dir = container_work_dir.join(repo_name).join(repo_name);

    let dirs = RustRunDirectories {
        container_work_dir,
        shims_dir,
        signals_dir,
        diag_dir,
        tool_cache_dir,
        pnpm_store_dir,
        npm_cache_dir,
        yarn_cache_dir,
        bun_cache_dir,
        playwright_cache_dir,
        cypress_cache_dir,
        warm_modules_dir,
        host_runner_dir,
        workspace_dir,
    };

    for dir in [
        &dirs.container_work_dir,
        &dirs.shims_dir,
        &dirs.signals_dir,
        &dirs.diag_dir,
    ] {
        let _ = fs::remove_dir_all(dir);
    }

    for dir in [
        &dirs.container_work_dir,
        &dirs.shims_dir,
        &dirs.signals_dir,
        &dirs.diag_dir,
        &dirs.tool_cache_dir,
        &dirs.pnpm_store_dir,
        &dirs.npm_cache_dir,
        &dirs.yarn_cache_dir,
        &dirs.bun_cache_dir,
        &dirs.playwright_cache_dir,
        &dirs.cypress_cache_dir,
        &dirs.warm_modules_dir,
        &dirs.host_runner_dir,
        &dirs.workspace_dir,
    ] {
        fs::create_dir_all(dir).map_err(|err| err.to_string())?;
        chmod_best_effort(dir);
    }
    fs::write(dirs.signals_dir.join("step-output"), "").map_err(|err| err.to_string())?;
    chmod_best_effort(&dirs.signals_dir.join("step-output"));

    Ok(dirs)
}

fn write_git_shim(shims_dir: &Path, fake_sha: &str) -> Result<(), String> {
    fs::create_dir_all(shims_dir).map_err(|err| err.to_string())?;
    let shim = shims_dir.join("git");
    let content = include_str!("git_shim.sh").replace("__AGENT_CI_FAKE_SHA__", fake_sha);
    fs::write(&shim, content).map_err(|err| err.to_string())?;
    chmod_best_effort(&shim);
    Ok(())
}

fn init_fake_git_repo(dir: &Path, github_repo: &str) -> Result<(), String> {
    run_git_ok(dir, &["init"])?;
    run_git_ok(dir, &["config", "user.name", "agent-ci"])?;
    run_git_ok(dir, &["config", "user.email", "agent-ci@example.com"])?;
    let _ = Command::new("git")
        .args(["remote", "remove", "origin"])
        .current_dir(dir)
        .output();
    run_git_ok(
        dir,
        &[
            "remote",
            "add",
            "origin",
            &format!("http://127.0.0.1/{github_repo}"),
        ],
    )?;
    run_git_ok(dir, &["add", "."])?;
    let _ = Command::new("git")
        .args(["commit", "-m", "workspace"])
        .current_dir(dir)
        .output();
    run_git_ok(dir, &["branch", "-M", "main"])?;
    let _ = Command::new("git")
        .args(["update-ref", "refs/remotes/origin/main", "HEAD"])
        .current_dir(dir)
        .output();
    let _ = Command::new("git")
        .args(["checkout", "--detach", "HEAD"])
        .current_dir(dir)
        .output();
    Ok(())
}

fn run_git_ok(dir: &Path, args: &[&str]) -> Result<(), String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|err| format!("failed to run git: {err}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
    }
}

fn ensure_docker_vm_runner_externals(runner_image: &str) -> Result<(), String> {
    let vm_externals_dir = "/home/runner/externals";
    let script = r#"set -e
if [ -x /target/node20/bin/node ]; then
  exit 0
fi
if [ ! -d /home/runner/externals ]; then
  echo "runner image does not contain /home/runner/externals" >&2
  exit 1
fi
mkdir -p /target
cp -a /home/runner/externals/. /target/
chmod -R a+rX /target 2>/dev/null || true
"#;
    let output = Command::new("docker")
        .args([
            "run",
            "--rm",
            "-u",
            "root",
            "-v",
            &format!("{vm_externals_dir}:/target"),
            runner_image,
            "sh",
            "-c",
            script,
        ])
        .output()
        .map_err(|err| format!("failed to prepare Docker VM runner externals: {err}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "failed to prepare Docker VM runner externals: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

fn prepare_docker_vm_work_dir(host_work_dir: &Path) -> Result<String, String> {
    let vm_work_dir = "/home/runner/_work".to_owned();
    let host = host_work_dir.to_string_lossy().into_owned();
    let script = "set -e; rm -rf /to/* /to/.[!.]* /to/..?* 2>/dev/null || true; cp -a /from/. /to/";
    let output = Command::new("docker")
        .args([
            "run",
            "--rm",
            "-v",
            &format!("{host}:/from:ro"),
            "-v",
            &format!("{vm_work_dir}:/to"),
            "alpine:3.20",
            "sh",
            "-c",
            script,
        ])
        .output()
        .map_err(|err| format!("failed to prepare Docker VM work dir: {err}"))?;
    if output.status.success() {
        Ok(vm_work_dir)
    } else {
        Err(format!(
            "failed to prepare Docker VM work dir: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

fn chmod_best_effort(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = fs::symlink_metadata(path) {
            let mut permissions = metadata.permissions();
            permissions.set_mode(if metadata.is_dir() { 0o777 } else { 0o755 });
            let _ = fs::set_permissions(path, permissions);
        }
    }
}

fn chmod_tree_best_effort(path: &Path) {
    chmod_best_effort(path);
    let Ok(entries) = fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        let child = entry.path();
        if child.is_dir() {
            chmod_tree_best_effort(&child);
        } else {
            chmod_best_effort(&child);
        }
    }
}

fn job_result_input(result: &JobResult) -> JobResultInput {
    JobResultInput {
        name: result.name.clone(),
        workflow: result.workflow.clone(),
        succeeded: result.succeeded,
        duration_ms: result.duration_ms,
        failing_step: result.failed_step.clone(),
        debug_log_path: result.debug_log_path.clone(),
        steps: result
            .steps
            .iter()
            .map(|step| StepResultInput {
                name: step.name.clone(),
                status: match step.status {
                    StepStatus::Passed => StateStepResultStatus::Passed,
                    StepStatus::Failed => StateStepResultStatus::Failed,
                    StepStatus::Skipped => StateStepResultStatus::Skipped,
                },
                log_path: step.log_path.clone(),
            })
            .collect(),
    }
}

fn run_result_branch(plan: &RunPlan) -> String {
    match &plan.selection {
        RunSelection::AllRelevant { branch, .. } => branch.clone(),
        RunSelection::SingleWorkflow => {
            current_branch(&plan.repo_root).unwrap_or_else(|_| "main".to_owned())
        }
    }
}

fn resolve_github_repo(repo_root: &Path) -> String {
    if let Ok(repo) = std::env::var("GITHUB_REPOSITORY") {
        let repo = repo.trim();
        if !repo.is_empty() && repo.contains('/') {
            return repo.to_owned();
        }
    }

    if let Ok(url) = git(repo_root, None, &["remote", "get-url", "origin"])
        && let Some(repo) = github_repo_from_remote(url.trim())
    {
        return repo;
    }

    let repo_name = repo_root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("repo");
    format!("local/{repo_name}")
}

fn github_repo_from_remote(url: &str) -> Option<String> {
    let without_suffix = url.strip_suffix(".git").unwrap_or(url);
    if let Some((_, path)) = without_suffix.split_once("github.com:") {
        return normalize_repo_path(path);
    }
    if let Some(index) = without_suffix.find("github.com/") {
        return normalize_repo_path(&without_suffix[index + "github.com/".len()..]);
    }
    if without_suffix.matches('/').count() >= 1 {
        return normalize_repo_path(
            without_suffix
                .rsplit_once('@')
                .map_or(without_suffix, |(_, path)| path),
        );
    }
    None
}

fn normalize_repo_path(path: &str) -> Option<String> {
    let parts = path.trim_matches('/').split('/').collect::<Vec<_>>();
    if parts.len() >= 2 {
        Some(format!(
            "{}/{}",
            parts[parts.len() - 2],
            parts[parts.len() - 1]
        ))
    } else {
        None
    }
}

fn format_planned_target(target: &PlannedJobTarget) -> String {
    match target {
        PlannedJobTarget::Linux { runs_on } | PlannedJobTarget::MacOs { runs_on } => {
            runs_on.clone()
        }
        PlannedJobTarget::ReusableWorkflow { uses } => uses.clone(),
        PlannedJobTarget::Unknown => "unknown target".to_owned(),
    }
}

const EVENT_SCHEMA_VERSION: u32 = 1;
const DETACHED_ENV: &str = "AGENT_CI_DETACHED";
const PAUSED_EXIT_CODE: i32 = 77;

fn json_mode_enabled(args: &RunArgs) -> bool {
    args.json || std::env::var("AGENT_CI_JSON").is_ok_and(|value| value == "1")
}

fn agent_mode_enabled(args: &RunArgs) -> bool {
    args.quiet || std::env::var("AI_AGENT").is_ok_and(|value| value == "1")
}

fn is_detached_worker() -> bool {
    std::env::var_os(DETACHED_ENV).is_some_and(|value| PathBuf::from(value).is_absolute())
}

fn is_force_detached_requested() -> bool {
    std::env::var_os(DETACHED_ENV).is_some_and(|value| !PathBuf::from(value).is_absolute())
}

fn should_launch_detached(args: &RunArgs) -> bool {
    if is_detached_worker() || !args.pause_on_failure || agent_mode_enabled(args) {
        return false;
    }
    is_force_detached_requested() || !std::io::stdout().is_terminal()
}

fn run_detached_launcher(stdout: &mut impl Write, stderr: &mut impl Write) -> i32 {
    let log_path = match detached_worker_log_path() {
        Ok(path) => path,
        Err(err) => {
            let _ = writeln!(
                stderr,
                "[Agent CI] Error: failed to create launcher log: {err}"
            );
            return 1;
        }
    };
    let log_file = match fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        Ok(file) => file,
        Err(err) => {
            let _ = writeln!(
                stderr,
                "[Agent CI] Error: failed to open launcher log: {err}"
            );
            return 1;
        }
    };
    let stderr_file = match log_file.try_clone() {
        Ok(file) => file,
        Err(err) => {
            let _ = writeln!(
                stderr,
                "[Agent CI] Error: failed to clone launcher log: {err}"
            );
            return 1;
        }
    };
    let current_exe = match std::env::current_exe() {
        Ok(path) => path,
        Err(err) => {
            let _ = writeln!(
                stderr,
                "[Agent CI] Error: failed to resolve current executable: {err}"
            );
            return 1;
        }
    };

    let mut command = Command::new(current_exe);
    command
        .args(std::env::args_os().skip(1))
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(stderr_file))
        .env(DETACHED_ENV, &log_path);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            let _ = writeln!(
                stderr,
                "[Agent CI] Error: failed to launch detached worker: {err}"
            );
            return 1;
        }
    };

    tail_detached_worker(&log_path, &mut child, stdout)
}

fn detached_worker_log_path() -> Result<PathBuf, String> {
    let env = std::env::vars().collect::<BTreeMap<_, _>>();
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let state_dir = resolve_state_dir(&StateDirEnv::from_env(&env), std::env::consts::OS, &home);
    let launcher_dir = state_dir.join("launchers");
    fs::create_dir_all(&launcher_dir).map_err(|err| err.to_string())?;
    Ok(launcher_dir.join(format!(
        "worker-{}-{}.log",
        now_millis(),
        std::process::id()
    )))
}

fn tail_detached_worker(
    log_path: &Path,
    child: &mut std::process::Child,
    stdout: &mut impl Write,
) -> i32 {
    let mut offset = 0_u64;
    let mut buffer = String::new();
    let mut drained_after_exit = false;

    loop {
        if let Ok((new_offset, chunk)) = read_log_chunk(log_path, offset) {
            offset = new_offset;
            buffer.push_str(&chunk);
        }

        while let Some(index) = buffer.find('\n') {
            let line = buffer[..index].to_owned();
            buffer = buffer[index + 1..].to_owned();
            if let Some(event) = parse_log_event(&line) {
                match event.get("event").and_then(serde_json::Value::as_str) {
                    Some("run.paused") => {
                        let _ = writeln!(stdout, "{line}");
                        write_pause_hint(stdout, &event, log_path);
                        return PAUSED_EXIT_CODE;
                    }
                    Some("run.finish") => {
                        let _ = writeln!(stdout, "{line}");
                        return if event.get("status").and_then(serde_json::Value::as_str)
                            == Some("passed")
                        {
                            0
                        } else {
                            1
                        };
                    }
                    Some(_) => continue,
                    None => {}
                }
            }
            let _ = writeln!(stdout, "{line}");
        }

        match child.try_wait() {
            Ok(Some(status)) => {
                if drained_after_exit {
                    if !buffer.is_empty() {
                        let _ = write!(stdout, "{buffer}");
                    }
                    return status.code().unwrap_or(1);
                }
                drained_after_exit = true;
            }
            Ok(None) => {}
            Err(_) => return 1,
        }

        thread::sleep(Duration::from_millis(100));
    }
}

fn read_log_chunk(path: &Path, offset: u64) -> Result<(u64, String), String> {
    use std::io::{Read, Seek};
    let mut file = fs::File::open(path).map_err(|err| err.to_string())?;
    let len = file.metadata().map_err(|err| err.to_string())?.len();
    if len <= offset {
        return Ok((offset, String::new()));
    }
    file.seek(std::io::SeekFrom::Start(offset))
        .map_err(|err| err.to_string())?;
    let mut bytes = Vec::with_capacity((len - offset) as usize);
    file.read_to_end(&mut bytes)
        .map_err(|err| err.to_string())?;
    Ok((len, String::from_utf8_lossy(&bytes).into_owned()))
}

fn parse_log_event(line: &str) -> Option<serde_json::Value> {
    if !line.starts_with('{') {
        return None;
    }
    let value = serde_json::from_str::<serde_json::Value>(line).ok()?;
    let event = value.get("event").and_then(serde_json::Value::as_str)?;
    matches!(
        event,
        "run.start"
            | "run.finish"
            | "run.paused"
            | "job.start"
            | "job.finish"
            | "step.start"
            | "step.finish"
            | "diagnostic"
    )
    .then_some(value)
}

fn write_pause_hint(stdout: &mut impl Write, event: &serde_json::Value, log_path: &Path) {
    let runner = event
        .get("runner")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("<unknown>");
    let retry_cmd = event
        .get("retry_cmd")
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("agent-ci retry --name {runner}"));
    let _ = writeln!(
        stdout,
        "[Agent CI] Job paused. Worker continues in background.\n           Resume with: {retry_cmd}\n           Or abort with: agent-ci abort --name {runner}\n           Live log: {}",
        log_path.display()
    );
}

fn emit_run_start_event(plan: &RunPlan, stdout: &mut impl Write) {
    let mut event = serde_json::json!({
        "event": "run.start",
        "ts": event_timestamp(),
        "schemaVersion": EVENT_SCHEMA_VERSION,
        "runId": format!("run-{}", now_millis()),
    });
    if let RunSelection::AllRelevant { branch, .. } = &plan.selection {
        event["branch"] = serde_json::Value::String(branch.clone());
    }
    emit_json_event(stdout, event);
}

fn emit_run_finish_event(status: &str, stdout: &mut impl Write) {
    emit_json_event(
        stdout,
        serde_json::json!({
            "event": "run.finish",
            "ts": event_timestamp(),
            "status": status,
        }),
    );
}

fn emit_pause_event(
    stdout: &mut impl Write,
    stderr: &mut impl Write,
    json_mode: bool,
    runner_name: &str,
    job_display_name: &str,
    workflow: &str,
    signal: PausedSignal,
) {
    let step = signal.step.unwrap_or_else(|| "unknown".to_owned());
    let attempt = signal.attempt.unwrap_or(1);
    if json_mode {
        emit_json_event(
            stdout,
            serde_json::json!({
                "event": "run.paused",
                "ts": event_timestamp(),
                "runner": runner_name,
                "step": step.clone(),
                "attempt": attempt,
                "workflow": workflow,
                "retry_cmd": format!("agent-ci retry --name {runner_name}"),
            }),
        );
    }
    let _ = writeln!(
        stderr,
        "\n[Agent CI] Step failed: \"{step}\" ({workflow} > {job_display_name})"
    );
    if attempt > 1 {
        let _ = writeln!(stderr, "  Attempt: {attempt}");
    }
    let _ = writeln!(stderr, "  To retry:  agent-ci retry --name {runner_name}");
}

pub fn job_lifecycle_events(
    workflow: &str,
    job: &PlannedJob,
    result: &JobResult,
) -> Vec<serde_json::Value> {
    let ts = event_timestamp();
    let mut events = vec![serde_json::json!({
        "event": "job.start",
        "ts": ts,
        "job": job.id.clone(),
        "runner": job.runner_name.clone(),
        "workflow": workflow,
    })];

    for (index, step) in result.steps.iter().enumerate() {
        let step_index = index + 1;
        events.push(serde_json::json!({
            "event": "step.start",
            "ts": ts,
            "job": job.id.clone(),
            "runner": job.runner_name.clone(),
            "step": step.name.clone(),
            "index": step_index,
        }));
        events.push(serde_json::json!({
            "event": "step.finish",
            "ts": ts,
            "job": job.id.clone(),
            "runner": job.runner_name.clone(),
            "step": step.name.clone(),
            "index": step_index,
            "status": json_step_status(step.status),
        }));
    }

    events.push(serde_json::json!({
        "event": "job.finish",
        "ts": ts,
        "job": job.id.clone(),
        "runner": job.runner_name.clone(),
        "workflow": workflow,
        "status": if result.succeeded { "passed" } else { "failed" },
        "durationMs": result.duration_ms,
    }));
    events
}

fn json_step_status(status: StepStatus) -> &'static str {
    match status {
        StepStatus::Passed => "passed",
        StepStatus::Failed => "failed",
        StepStatus::Skipped => "skipped",
    }
}

fn emit_json_event(stdout: &mut impl Write, event: serde_json::Value) {
    if let Ok(line) = serde_json::to_string(&event) {
        let _ = writeln!(stdout, "{line}");
    }
}

fn event_timestamp() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let (year, month, day, hour, minute, second) = unix_seconds_to_utc(duration.as_secs());
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z",
        millis = duration.subsec_millis()
    )
}

fn unix_seconds_to_utc(seconds: u64) -> (i32, u32, u32, u32, u32, u32) {
    let days = (seconds / 86_400) as i64;
    let seconds_of_day = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    let hour = (seconds_of_day / 3_600) as u32;
    let minute = ((seconds_of_day % 3_600) / 60) as u32;
    let second = (seconds_of_day % 60) as u32;
    (year, month, day, hour, minute, second)
}

fn civil_from_days(days_since_unix_epoch: i64) -> (i32, u32, u32) {
    let z = days_since_unix_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year as i32, month as u32, day as u32)
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis())
}

pub fn discover_workflow_run(
    args: &RunArgs,
    current_dir: &Path,
) -> Result<WorkflowDiscovery, RunDiscoveryError> {
    let workflow_arg = args
        .workflow
        .as_ref()
        .ok_or(RunDiscoveryError::MissingWorkflow)?;
    let repo_root = resolve_repo_root(current_dir);
    let workflow_path = resolve_workflow_arg_path(workflow_arg, current_dir, &repo_root);
    if !workflow_path.exists() {
        return Err(RunDiscoveryError::WorkflowNotFound(workflow_path));
    }

    let workflow = parse_workflow_file(&workflow_path)?;
    let repo_root = resolve_repo_root_from_workflow(&workflow_path, current_dir);
    let effective_sha = resolve_effective_sha(&repo_root, args.sha.as_deref())?;
    let jobs = runnable_jobs(&workflow);
    let diagnostics = workflow
        .diagnostics
        .iter()
        .map(|diagnostic| diagnostic.message.clone())
        .collect();

    Ok(WorkflowDiscovery {
        workflow_path,
        repo_root,
        effective_sha,
        jobs,
        diagnostics,
    })
}

pub fn discover_all_workflows(
    current_dir: &Path,
) -> Result<AllWorkflowDiscovery, RunDiscoveryError> {
    let repo_root = resolve_repo_root(current_dir);
    let branch = current_branch(&repo_root)?;
    let changed_files = get_changed_files(&repo_root);
    let (relevant, skipped) = discover_relevant_workflows(&repo_root, &branch, &changed_files)?;

    Ok(AllWorkflowDiscovery {
        repo_root,
        branch,
        changed_files,
        relevant,
        skipped,
    })
}

pub fn discover_relevant_workflows(
    repo_root: &Path,
    branch: &str,
    changed_files: &[String],
) -> Result<(Vec<PathBuf>, Vec<SkippedWorkflow>), RunDiscoveryError> {
    let workflows_dir = repo_root.join(".github/workflows");
    if !workflows_dir.exists() {
        return Err(RunDiscoveryError::MissingWorkflowsDir(
            repo_root.to_path_buf(),
        ));
    }

    let mut files = fs::read_dir(&workflows_dir)
        .map_err(|_| RunDiscoveryError::MissingWorkflowsDir(repo_root.to_path_buf()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|value| value.to_str())
                .is_some_and(|extension| matches!(extension, "yml" | "yaml"))
        })
        .collect::<Vec<_>>();
    files.sort();

    let mut relevant = Vec::new();
    let mut skipped = Vec::new();
    for file in files {
        match parse_workflow_file(&file) {
            Ok(workflow) => {
                let Some(on) = workflow.on.as_ref() else {
                    skipped.push(SkippedWorkflow {
                        path: file,
                        reason: "missing `on` trigger".to_owned(),
                    });
                    continue;
                };
                let events = extract_events(on);
                if is_workflow_relevant(&events, branch, changed_files) {
                    relevant.push(file);
                } else {
                    skipped.push(SkippedWorkflow {
                        path: file,
                        reason: "event filters did not match".to_owned(),
                    });
                }
            }
            Err(err) => skipped.push(SkippedWorkflow {
                path: file,
                reason: err.to_string(),
            }),
        }
    }

    Ok((relevant, skipped))
}

pub fn get_changed_files(repo_root: &Path) -> Vec<String> {
    git(repo_root, None, &["diff", "--name-only", "HEAD~1"])
        .map(|stdout| {
            stdout
                .lines()
                .filter(|line| !line.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

pub fn runnable_jobs(workflow: &WorkflowDocument) -> Vec<RunnableJob> {
    workflow
        .jobs
        .values()
        .map(|job| RunnableJob {
            id: job.id.clone(),
            display_name: job.name.clone().unwrap_or_else(|| job.id.clone()),
            runs_on: job.runs_on.as_ref().map(format_runs_on),
            uses: job.uses.clone(),
            step_count: job.steps.len(),
        })
        .collect()
}

pub fn resolve_effective_sha(
    repo_root: &Path,
    explicit_sha: Option<&str>,
) -> Result<EffectiveSha, RunDiscoveryError> {
    if let Some(sha) = explicit_sha {
        let head_sha = resolve_head_sha(repo_root, sha)?;
        return Ok(EffectiveSha {
            head_sha,
            sha_ref: Some(sha.to_owned()),
            source: EffectiveShaSource::Explicit,
        });
    }

    if let Some(dirty_sha) = compute_dirty_sha(repo_root) {
        return Ok(EffectiveSha {
            head_sha: dirty_sha,
            sha_ref: None,
            source: EffectiveShaSource::DirtyTree,
        });
    }

    Ok(EffectiveSha {
        head_sha: resolve_head_sha(repo_root, "HEAD")?,
        sha_ref: Some("HEAD".to_owned()),
        source: EffectiveShaSource::Head,
    })
}

fn current_branch(repo_root: &Path) -> Result<String, RunDiscoveryError> {
    git(repo_root, None, &["rev-parse", "--abbrev-ref", "HEAD"]).map_err(|_| {
        RunDiscoveryError::RefResolve {
            repo_root: repo_root.to_path_buf(),
            reference: "HEAD".to_owned(),
        }
    })
}

fn resolve_head_sha(repo_root: &Path, sha: &str) -> Result<String, RunDiscoveryError> {
    git(repo_root, None, &["rev-parse", sha]).map_err(|_| RunDiscoveryError::RefResolve {
        repo_root: repo_root.to_path_buf(),
        reference: sha.to_owned(),
    })
}

fn compute_dirty_sha(repo_root: &Path) -> Option<String> {
    let status = git(repo_root, None, &["status", "--porcelain"]).ok()?;
    if status.is_empty() {
        return None;
    }

    let git_dir = git(repo_root, None, &["rev-parse", "--git-dir"]).ok()?;
    let git_dir = {
        let path = PathBuf::from(git_dir);
        if path.is_absolute() {
            path
        } else {
            repo_root.join(path)
        }
    };
    let tmp_index = git_dir.join(format!("index-agent-ci-rust-{}", now_nanos()));

    let result = (|| {
        fs::copy(git_dir.join("index"), &tmp_index).ok()?;
        let tmp_index_value = tmp_index.to_string_lossy().into_owned();
        let env = [("GIT_INDEX_FILE", tmp_index_value.as_str())];
        git(repo_root, Some(&env), &["add", "-A"]).ok()?;
        let tree = git(repo_root, Some(&env), &["write-tree"]).ok()?;
        let commit_env = [
            ("GIT_AUTHOR_NAME", "Agent CI"),
            ("GIT_AUTHOR_EMAIL", "agent-ci@example.invalid"),
            ("GIT_COMMITTER_NAME", "Agent CI"),
            ("GIT_COMMITTER_EMAIL", "agent-ci@example.invalid"),
        ];
        git(
            repo_root,
            Some(&commit_env),
            &[
                "commit-tree",
                &tree,
                "-p",
                "HEAD",
                "-m",
                "agent-ci: dirty working tree",
            ],
        )
        .ok()
    })();

    let _ = fs::remove_file(tmp_index);
    result
}

fn git(repo_root: &Path, env: Option<&[(&str, &str)]>, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("git");
    command.args(args).current_dir(repo_root);
    if let Some(env) = env {
        for (key, value) in env {
            command.env(key, value);
        }
    }
    let output = command.output().map_err(|err| err.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn resolve_workflow_arg_path(workflow: &str, current_dir: &Path, repo_root: &Path) -> PathBuf {
    let workflow_path = Path::new(workflow);
    if workflow_path.is_absolute() {
        return workflow_path.to_path_buf();
    }

    let workflows_dir = repo_root.join(".github/workflows");
    let paths_to_try = [
        current_dir.join(workflow_path),
        repo_root.join(workflow_path),
        workflows_dir.join(workflow_path),
    ];
    paths_to_try
        .iter()
        .find(|path| path.exists())
        .cloned()
        .unwrap_or_else(|| repo_root.join(workflow_path))
}

fn resolve_repo_root_from_workflow(workflow_path: &Path, current_dir: &Path) -> PathBuf {
    let mut dir = workflow_path
        .parent()
        .unwrap_or(workflow_path)
        .to_path_buf();
    loop {
        if dir.join(".git").exists() {
            return dir;
        }
        if !dir.pop() {
            return resolve_repo_root(current_dir);
        }
    }
}

fn format_runs_on(runs_on: &RunsOn) -> String {
    match runs_on {
        RunsOn::Single(value) => value.clone(),
        RunsOn::Labels(values) => values.join(", "),
        RunsOn::Other(value) => value.clone(),
    }
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunDiscoveryError {
    MissingWorkflow,
    WorkflowNotFound(PathBuf),
    WorkflowParse(String),
    MissingWorkflowsDir(PathBuf),
    RefResolve {
        repo_root: PathBuf,
        reference: String,
    },
}

impl From<WorkflowParseError> for RunDiscoveryError {
    fn from(value: WorkflowParseError) -> Self {
        Self::WorkflowParse(value.to_string())
    }
}

impl std::fmt::Display for RunDiscoveryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingWorkflow => write!(formatter, "run requires --workflow <path>"),
            Self::WorkflowNotFound(path) => {
                write!(formatter, "Workflow file not found: {}", path.display())
            }
            Self::WorkflowParse(message) => write!(formatter, "{message}"),
            Self::MissingWorkflowsDir(repo_root) => write!(
                formatter,
                "No .github/workflows directory found in {}",
                repo_root.display()
            ),
            Self::RefResolve { reference, .. } => {
                write!(formatter, "Failed to resolve ref: {reference}")
            }
        }
    }
}

impl std::error::Error for RunDiscoveryError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("agent-ci-rust-run-{name}-{}", now_nanos()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git_ok(repo: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(repo)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn init_repo() -> PathBuf {
        let repo = temp_dir("repo");
        git_ok(&repo, &["init"]);
        fs::write(repo.join("README.md"), "hello\n").unwrap();
        git_ok(&repo, &["add", "README.md"]);
        git_ok(
            &repo,
            &[
                "-c",
                "user.email=test@example.com",
                "-c",
                "user.name=Test User",
                "commit",
                "-m",
                "init",
            ],
        );
        repo
    }

    fn write_workflow(repo: &Path) -> PathBuf {
        let workflow_path = repo.join(".github/workflows/ci.yml");
        fs::create_dir_all(workflow_path.parent().unwrap()).unwrap();
        fs::write(
            &workflow_path,
            r#"name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: cargo test
  lint:
    name: Lint job
    runs-on: [ubuntu-latest, large]
    needs: test
    steps:
      - uses: actions/checkout@v4
"#,
        )
        .unwrap();
        workflow_path
    }

    fn write_matrix_workflow(repo: &Path) -> PathBuf {
        let workflow_path = repo.join(".github/workflows/matrix.yml");
        fs::create_dir_all(workflow_path.parent().unwrap()).unwrap();
        fs::write(
            &workflow_path,
            r#"name: Matrix
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20, 22]
    steps:
      - run: echo ${{ matrix.node }}
  deploy:
    runs-on: ubuntu-latest
    needs: test
    steps:
      - run: echo deploy
"#,
        )
        .unwrap();
        workflow_path
    }

    fn write_macos_workflow(repo: &Path) -> PathBuf {
        let workflow_path = repo.join(".github/workflows/macos.yml");
        fs::create_dir_all(workflow_path.parent().unwrap()).unwrap();
        fs::write(
            &workflow_path,
            r#"name: macOS
on: push
jobs:
  mac:
    runs-on: macos-14
    steps:
      - run: sw_vers
"#,
        )
        .unwrap();
        workflow_path
    }

    #[test]
    fn discovers_jobs_for_one_workflow() {
        let repo = init_repo();
        let workflow = write_workflow(&repo);
        let args = RunArgs {
            workflow: Some(workflow.to_string_lossy().into_owned()),
            ..RunArgs::default()
        };

        let discovery = discover_workflow_run(&args, &repo).unwrap();

        assert_eq!(discovery.repo_root, repo);
        assert_eq!(discovery.jobs.len(), 2);
        assert_eq!(discovery.jobs[0].id, "lint");
        assert_eq!(discovery.jobs[0].display_name, "Lint job");
        assert_eq!(
            discovery.jobs[0].runs_on,
            Some("ubuntu-latest, large".to_owned())
        );
        assert_eq!(discovery.jobs[1].id, "test");
        assert_eq!(discovery.jobs[1].step_count, 1);
    }

    #[test]
    fn plans_jobs_for_one_workflow() {
        let repo = init_repo();
        let workflow = write_workflow(&repo);
        let args = RunArgs {
            workflow: Some(workflow.to_string_lossy().into_owned()),
            max_jobs: Some(2),
            pause_on_failure: true,
            ..RunArgs::default()
        };

        let plan = plan_run(&args, &repo).unwrap();

        assert_eq!(plan.repo_root, repo);
        assert_eq!(plan.max_jobs, Some(2));
        assert!(plan.pause_on_failure);
        assert_eq!(plan.workflows.len(), 1);
        assert_eq!(plan.workflows[0].workflow_path, workflow);
        assert_eq!(plan.workflows[0].jobs.len(), 2);
        assert_eq!(plan.workflows[0].jobs[0].id, "lint");
        assert_eq!(plan.workflows[0].jobs[0].display_name, "Lint job");
        assert_eq!(plan.workflows[0].jobs[0].runner_name, "agent-ci-1-j1");
        assert_eq!(
            plan.workflows[0].jobs[0].target,
            PlannedJobTarget::Linux {
                runs_on: "ubuntu-latest, large".to_owned()
            }
        );
        assert_eq!(plan.workflows[0].jobs[0].needs, vec!["test".to_owned()]);
        assert_eq!(plan.workflows[0].jobs[1].id, "test");
        assert_eq!(plan.workflows[0].jobs[1].runner_name, "agent-ci-1-j2");
        assert_eq!(plan.workflows[0].schedule, vec![vec!["test"], vec!["lint"]]);
    }

    #[test]
    fn builds_runner_execution_plan_and_dtu_seed_for_planned_job() {
        let repo = init_repo();
        let workflow_path = write_workflow(&repo);
        let args = RunArgs {
            workflow: Some(workflow_path.to_string_lossy().into_owned()),
            pause_on_failure: true,
            ..RunArgs::default()
        };
        let plan = plan_run(&args, &repo).unwrap();
        let workflow = &plan.workflows[0];
        let job = &workflow.jobs[1];
        let log_dir = repo.join("logs");
        let signals_dir = repo.join("signals");

        let execution = runner_execution_plan_for_job(
            workflow,
            job,
            crate::runner_image::UPSTREAM_RUNNER_IMAGE,
            log_dir.clone(),
            signals_dir.clone(),
            plan.pause_on_failure,
        );
        let seed =
            dtu_job_seed_for_planned_job(&plan, workflow, job, "owner/repo", BTreeMap::new());

        assert_eq!(execution.workflow, "ci.yml");
        assert_eq!(execution.job_id, "test");
        assert_eq!(execution.runner_name, "agent-ci-1-j2");
        assert_eq!(execution.image, crate::runner_image::UPSTREAM_RUNNER_IMAGE);
        assert_eq!(execution.log_dir, log_dir);
        assert_eq!(execution.signals_dir, signals_dir);
        assert!(execution.pause_on_failure);
        assert_eq!(seed.runner_name, "agent-ci-1-j2");
        assert_eq!(seed.name, "test");
        assert_eq!(seed.workflow_name, "ci");
        assert_eq!(seed.github_repo, "owner/repo");
        assert_eq!(seed.real_head_sha.len(), 40);
        assert_eq!(seed.steps[0].name, "cargo test");
        assert_eq!(seed.steps[0].run.as_deref(), Some("cargo test"));
    }

    #[test]
    fn plan_routes_macos_runs_on_to_macos_target() {
        let repo = init_repo();
        let workflow = write_macos_workflow(&repo);
        let args = RunArgs {
            workflow: Some(workflow.to_string_lossy().into_owned()),
            ..RunArgs::default()
        };

        let plan = plan_run(&args, &repo).unwrap();
        let job = &plan.workflows[0].jobs[0];

        assert_eq!(
            job.target,
            PlannedJobTarget::MacOs {
                runs_on: "macos-14".to_owned()
            }
        );
        assert_eq!(
            execution_route_for_job(job, &HostCapability::Supported),
            JobExecutionRoute::MacOs
        );
        let unsupported = HostCapability::Unsupported {
            reason: "macOS VM runner requires `tart` to be installed.".to_owned(),
            hint: Some("Install with: brew install cirruslabs/cli/tart".to_owned()),
        };
        assert_eq!(
            execution_route_for_job(job, &unsupported),
            JobExecutionRoute::Skip {
                reason: "macos-14: macOS VM runner requires `tart` to be installed. Install with: brew install cirruslabs/cli/tart".to_owned()
            }
        );
    }

    #[test]
    fn plan_expands_matrix_jobs_with_runner_names_and_strategy_metadata() {
        let repo = init_repo();
        let workflow = write_matrix_workflow(&repo);
        let args = RunArgs {
            workflow: Some(workflow.to_string_lossy().into_owned()),
            ..RunArgs::default()
        };

        let plan = plan_run(&args, &repo).unwrap();
        let jobs = &plan.workflows[0].jobs;

        assert_eq!(jobs.len(), 3);
        assert_eq!(jobs[1].id, "test");
        assert_eq!(jobs[1].runner_name, "agent-ci-1-j2-m1");
        assert_eq!(
            jobs[1].matrix_context.as_ref().unwrap().get("node"),
            Some(&"20".to_owned())
        );
        assert_eq!(
            jobs[1].matrix_context.as_ref().unwrap().get("__job_total"),
            Some(&"2".to_owned())
        );
        assert_eq!(
            jobs[2].matrix_context.as_ref().unwrap().get("__job_index"),
            Some(&"1".to_owned())
        );
        assert_eq!(
            plan.workflows[0].schedule,
            vec![vec!["agent-ci-1-j2-m1", "agent-ci-1-j2-m2"], vec!["deploy"]]
        );
    }

    #[test]
    fn plan_collapses_matrix_jobs_when_no_matrix_is_set() {
        let repo = init_repo();
        let workflow = write_matrix_workflow(&repo);
        let args = RunArgs {
            workflow: Some(workflow.to_string_lossy().into_owned()),
            no_matrix: true,
            ..RunArgs::default()
        };

        let plan = plan_run(&args, &repo).unwrap();
        let jobs = &plan.workflows[0].jobs;

        assert_eq!(jobs.len(), 2);
        assert_eq!(jobs[1].runner_name, "agent-ci-1-j2-m1");
        assert_eq!(
            jobs[1].matrix_context.as_ref().unwrap().get("node"),
            Some(&"20".to_owned())
        );
        assert_eq!(
            jobs[1].matrix_context.as_ref().unwrap().get("__job_total"),
            Some(&"1".to_owned())
        );
        assert_eq!(
            plan.workflows[0].schedule,
            vec![vec!["agent-ci-1-j2-m1"], vec!["deploy"]]
        );
    }

    #[test]
    fn human_summary_prints_failures_status_duration_and_hints() {
        let repo = temp_dir("summary-repo");
        let working_dir = temp_dir("summary-work");
        let step_log = repo.join("step.log");
        fs::write(&step_log, "missing-tool: command not found\n").unwrap();
        let result = JobResult {
            name: "test".to_owned(),
            workflow: "ci.yml".to_owned(),
            succeeded: false,
            paused: false,
            duration_ms: 1500,
            failed_step: Some("Run tests".to_owned()),
            debug_log_path: None,
            steps: vec![crate::runner::StepResult {
                name: "Run tests".to_owned(),
                status: StepStatus::Failed,
                log_path: Some(step_log),
            }],
        };
        let mut output = Vec::new();

        print_human_summary(
            &[result],
            Some(&working_dir),
            &repo,
            &working_dir,
            &BTreeMap::new(),
            &mut output,
        );
        let output = String::from_utf8(output).unwrap();

        assert!(output.contains("━━━ FAILURES"));
        assert!(output.contains("✗ ci.yml > test > \"Run tests\""));
        assert!(output.contains("missing-tool: command not found"));
        assert!(output.contains("Hint: `missing-tool` is not in agent-ci's default runner image."));
        assert!(output.contains("Status:    ✗ 1 failed, 0 passed (1 total)"));
        assert!(output.contains("Duration:  2s"));
        assert!(output.contains(&format!("Root:      {}", working_dir.display())));
    }

    #[test]
    fn human_summary_suppresses_missing_tool_hint_for_custom_runner_images() {
        let repo = temp_dir("summary-custom-repo");
        let working_dir = temp_dir("summary-custom-work");
        let mut env = BTreeMap::new();
        env.insert(
            "AGENT_CI_RUNNER_IMAGE".to_owned(),
            "custom:latest".to_owned(),
        );

        assert!(detect_missing_tool_hint("tool: command not found", &repo, &env).is_none());
        assert!(
            detect_toolcache_hint("tar: bin/npm: Cannot open: Permission denied", &working_dir)
                .is_some()
        );
    }

    fn planned_job(id: &str, needs: &[&str], if_condition: Option<&str>) -> PlannedJob {
        PlannedJob {
            id: id.to_owned(),
            display_name: id.to_owned(),
            runner_name: format!("agent-ci-1-{id}"),
            target: PlannedJobTarget::Linux {
                runs_on: "ubuntu-latest".to_owned(),
            },
            needs: needs.iter().map(|need| (*need).to_owned()).collect(),
            if_condition: if_condition.map(str::to_owned),
            env: BTreeMap::new(),
            outputs: BTreeMap::new(),
            services: Vec::new(),
            container: None,
            steps: vec![PlannedStep {
                id: None,
                name: "echo test".to_owned(),
                index: 1,
                run: Some("echo test".to_owned()),
                uses: None,
                if_condition: None,
                shell: None,
                working_directory: None,
                env: BTreeMap::new(),
                with: BTreeMap::new(),
            }],
            step_count: 1,
            matrix_context: None,
        }
    }

    #[test]
    fn schedules_jobs_in_dependency_waves() {
        let jobs = vec![
            planned_job("build", &[], None),
            planned_job("lint", &[], None),
            planned_job("test", &["build"], None),
            planned_job("deploy", &["build", "lint"], None),
        ];

        let waves = schedule_job_waves(&jobs);

        assert_eq!(waves, vec![vec!["build", "lint"], vec!["deploy", "test"]]);
    }

    #[test]
    fn skips_jobs_when_needed_jobs_do_not_succeed_by_default() {
        let job = planned_job("deploy", &["test"], None);
        let mut results = std::collections::BTreeMap::new();
        results.insert("test".to_owned(), JobResultStatus::Failure);

        assert!(matches!(
            decide_job_run(&job, &results),
            JobRunDecision::Skip { .. }
        ));
    }

    #[test]
    fn job_condition_status_functions_can_override_default_success_gate() {
        let always_job = planned_job("cleanup", &["test"], Some("${{ always() }}"));
        let failure_job = planned_job("notify", &["test"], Some("failure()"));
        let mut results = std::collections::BTreeMap::new();
        results.insert("test".to_owned(), JobResultStatus::Failure);

        assert_eq!(decide_job_run(&always_job, &results), JobRunDecision::Run);
        assert_eq!(decide_job_run(&failure_job, &results), JobRunDecision::Run);
    }

    #[test]
    fn job_condition_without_status_function_keeps_default_success_gate() {
        let job = planned_job("deploy", &["test"], Some("${{ true }}"));
        let mut results = std::collections::BTreeMap::new();
        results.insert("test".to_owned(), JobResultStatus::Skipped);

        assert!(matches!(
            decide_job_run(&job, &results),
            JobRunDecision::Skip { .. }
        ));
    }

    #[test]
    fn job_condition_can_read_needs_result() {
        let job = planned_job(
            "deploy",
            &["test"],
            Some("${{ always() && needs.test.result == 'skipped' }}"),
        );
        let mut results = std::collections::BTreeMap::new();
        results.insert("test".to_owned(), JobResultStatus::Skipped);

        assert_eq!(decide_job_run(&job, &results), JobRunDecision::Run);
    }

    #[test]
    fn unix_timestamp_format_matches_iso_utc_shape() {
        assert_eq!(unix_seconds_to_utc(1_704_067_200), (2024, 1, 1, 0, 0, 0));
    }

    #[test]
    fn json_run_mode_emits_run_start_and_finish_without_human_summary() {
        let repo = init_repo();
        let workflow = write_workflow(&repo);
        let args = RunArgs {
            workflow: Some(workflow.to_string_lossy().into_owned()),
            json: true,
            ..RunArgs::default()
        };
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();

        let exit_code = run_run_command(args, &mut stdout, &mut stderr);

        assert_eq!(exit_code, 1);
        let stdout = String::from_utf8(stdout).unwrap();
        let events = stdout
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(events[0]["event"], "run.start");
        assert_eq!(events[0]["schemaVersion"], EVENT_SCHEMA_VERSION);
        assert_eq!(events[1]["event"], "run.finish");
        assert_eq!(events[1]["status"], "failed");
        assert!(!stdout.contains("Discovered"));
        let _stderr = String::from_utf8(stderr).unwrap();
    }

    #[test]
    fn job_lifecycle_events_match_launcher_event_shapes() {
        let job = planned_job("test", &[], None);
        let result = JobResult {
            name: "test".to_owned(),
            workflow: "ci.yml".to_owned(),
            succeeded: true,
            paused: false,
            duration_ms: 42,
            failed_step: None,
            debug_log_path: None,
            steps: vec![crate::runner::StepResult {
                name: "Run tests".to_owned(),
                status: StepStatus::Passed,
                log_path: None,
            }],
        };

        let events = job_lifecycle_events("ci.yml", &job, &result);

        assert_eq!(events[0]["event"], "job.start");
        assert_eq!(events[1]["event"], "step.start");
        assert_eq!(events[2]["event"], "step.finish");
        assert_eq!(events[2]["status"], "passed");
        assert_eq!(events[3]["event"], "job.finish");
        assert_eq!(events[3]["status"], "passed");
        assert_eq!(events[3]["durationMs"], 42);
    }

    #[test]
    fn discovers_relevant_workflows_and_reports_skips() {
        let repo = temp_dir("relevant");
        let workflow_dir = repo.join(".github/workflows");
        fs::create_dir_all(&workflow_dir).unwrap();
        fs::write(
            workflow_dir.join("run.yml"),
            "on:\n  push:\n    branches: [main]\n    paths: [src/**]\njobs:\n  test:\n    runs-on: ubuntu-latest\n",
        )
        .unwrap();
        fs::write(
            workflow_dir.join("skip.yml"),
            "on:\n  push:\n    branches: [main]\n    paths: [docs/**]\njobs:\n  docs:\n    runs-on: ubuntu-latest\n",
        )
        .unwrap();
        fs::write(
            workflow_dir.join("dispatch.yml"),
            "on: workflow_dispatch\njobs:\n  manual:\n    runs-on: ubuntu-latest\n",
        )
        .unwrap();

        let (relevant, skipped) =
            discover_relevant_workflows(&repo, "main", &["src/lib.rs".to_owned()]).unwrap();

        let names = relevant
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["dispatch.yml".to_owned(), "run.yml".to_owned()]);
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0].path.file_name().unwrap(), "skip.yml");
        assert_eq!(skipped[0].reason, "event filters did not match");
    }

    #[test]
    fn explicit_sha_wins_when_resolving_effective_sha() {
        let repo = init_repo();
        let head = git(&repo, None, &["rev-parse", "HEAD"]).unwrap();

        let effective = resolve_effective_sha(&repo, Some("HEAD")).unwrap();

        assert_eq!(effective.head_sha, head);
        assert_eq!(effective.sha_ref, Some("HEAD".to_owned()));
        assert_eq!(effective.source, EffectiveShaSource::Explicit);
    }

    #[test]
    fn dirty_tree_sha_wins_over_head_when_no_sha_is_explicit() {
        let repo = init_repo();
        let head = git(&repo, None, &["rev-parse", "HEAD"]).unwrap();
        fs::write(repo.join("dirty.txt"), "dirty\n").unwrap();

        let effective = resolve_effective_sha(&repo, None).unwrap();

        assert_ne!(effective.head_sha, head);
        assert_eq!(effective.head_sha.len(), 40);
        assert_eq!(effective.sha_ref, None);
        assert_eq!(effective.source, EffectiveShaSource::DirtyTree);
    }

    #[test]
    fn clean_tree_defaults_to_head() {
        let repo = init_repo();
        let head = git(&repo, None, &["rev-parse", "HEAD"]).unwrap();

        let effective = resolve_effective_sha(&repo, None).unwrap();

        assert_eq!(effective.head_sha, head);
        assert_eq!(effective.sha_ref, Some("HEAD".to_owned()));
        assert_eq!(effective.source, EffectiveShaSource::Head);
    }
}
