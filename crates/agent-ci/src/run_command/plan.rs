use super::*;

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

pub(super) fn merged_job_env(
    workflow: &WorkflowDocument,
    job: &WorkflowJob,
) -> BTreeMap<String, String> {
    let mut env = workflow.env.clone();
    env.extend(job.env.clone());
    env
}

pub(super) fn planned_container(job: &WorkflowJob) -> Option<DtuJobContainer> {
    job.container.as_ref().map(|container| DtuJobContainer {
        image: container.image.clone(),
        env: container.env.clone(),
        ports: container.ports.clone(),
        volumes: container.volumes.clone(),
        options: container.options.clone(),
    })
}

pub(super) fn planned_services(job: &WorkflowJob) -> Vec<ServiceSpec> {
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

pub(super) fn planned_steps(
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

pub(super) fn effective_run_default(
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

pub(super) fn run_default_from_value(source: &serde_yaml::Value, key: &str) -> Option<String> {
    let defaults = mapping_value(source, "defaults")?;
    let run = mapping_value(defaults, "run")?;
    mapping_value(run, key)
        .and_then(serde_yaml::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub(super) fn mapping_value<'a>(
    source: &'a serde_yaml::Value,
    key: &str,
) -> Option<&'a serde_yaml::Value> {
    source
        .as_mapping()?
        .get(serde_yaml::Value::String(key.to_owned()))
}

pub(super) fn planned_step_name(step: &WorkflowStep, index: usize) -> String {
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

pub(super) fn planned_job_target(job: &WorkflowJob) -> PlannedJobTarget {
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

pub(super) fn expression_context_for_job(
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

pub(super) fn schedule_key(job: &PlannedJob) -> String {
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

pub(super) fn expression_context_for_step(
    base: &ExpressionContext,
    step: &PlannedStep,
) -> ExpressionContext {
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

pub(super) fn current_macos_vm_host_capability() -> HostCapability {
    check_macos_vm_host(
        std::env::consts::OS,
        std::env::consts::ARCH,
        command_exists("tart"),
        command_exists("sshpass"),
    )
}

pub(super) fn command_exists(command: &str) -> bool {
    Command::new("sh")
        .args(["-c", &format!("command -v {command} >/dev/null 2>&1")])
        .status()
        .is_ok_and(|status| status.success())
}

pub(super) fn needs_context_for_job(
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

pub(super) fn extract_static_step_outputs(job: &PlannedJob) -> BTreeMap<String, String> {
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

pub(super) fn parse_github_output_echo(line: &str) -> Option<(String, String)> {
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

pub(super) fn read_step_outputs(log_dir: &Path) -> BTreeMap<String, String> {
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

pub(super) fn resolve_job_outputs(
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

pub(super) fn resolve_step_output_template(
    template: &str,
    step_outputs: &BTreeMap<String, String>,
) -> String {
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

pub(super) fn resolve_step_output_expr(
    expr: &str,
    step_outputs: &BTreeMap<String, String>,
) -> String {
    let parts = expr.split('.').collect::<Vec<_>>();
    if parts.len() == 4 && parts[0] == "steps" && parts[2] == "outputs" {
        return step_outputs.get(parts[3]).cloned().unwrap_or_default();
    }
    String::new()
}

pub(super) fn json_value_to_string(value: &serde_json::Value) -> String {
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

pub(super) fn normalize_job_if(condition: &str) -> &str {
    let trimmed = condition.trim();
    trimmed
        .strip_prefix("${{")
        .and_then(|value| value.strip_suffix("}}"))
        .map(str::trim)
        .unwrap_or(trimmed)
}

pub(super) fn contains_status_check_function(condition: &str) -> bool {
    uses_status_check_function(condition)
}
