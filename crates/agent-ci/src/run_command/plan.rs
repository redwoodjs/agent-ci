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
        workflows: vec![plan_workflow_document(&workflow, 1, args.no_matrix)],
        pause_on_failure: args.pause_on_failure,
        no_matrix: args.no_matrix,
        max_jobs: args.max_jobs,
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
        workflows.push(plan_workflow_document(
            &workflow,
            (index + 1) as u32,
            args.no_matrix,
        ));
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
        max_jobs: args.max_jobs,
    })
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
        services: job.services.iter().map(service_spec_from_plan).collect(),
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
        needs_context: needs_context
            .into_iter()
            .map(|(name, context)| {
                (
                    name,
                    RuntimeNeedContext {
                        result: context.result,
                        outputs: context.outputs,
                    },
                )
            })
            .collect(),
        container: job.container.as_ref().map(dtu_container_from_plan),
        services: job.services.iter().map(service_spec_from_plan).collect(),
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

pub(super) fn service_spec_from_plan(service: &PlannedService) -> ServiceSpec {
    ServiceSpec {
        id: service.id.clone(),
        image: service.image.clone(),
        env: service.env.clone(),
        ports: service.ports.clone(),
        options: service.options.clone(),
        health_cmd: service.health_cmd.clone(),
    }
}

pub(super) fn dtu_container_from_plan(container: &PlannedJobContainer) -> DtuJobContainer {
    DtuJobContainer {
        image: container.image.clone(),
        env: container.env.clone(),
        ports: container.ports.clone(),
        volumes: container.volumes.clone(),
        options: container.options.clone(),
    }
}

pub(super) fn current_macos_vm_host_capability() -> HostCapability {
    let capability = check_macos_vm_host(
        std::env::consts::OS,
        std::env::consts::ARCH,
        command_exists("tart"),
        command_exists("sshpass"),
    );
    host_capability_from_macos(&capability)
}

pub(super) fn host_capability_from_macos(capability: &MacosHostCapability) -> HostCapability {
    match capability {
        MacosHostCapability::Supported => HostCapability::Supported,
        MacosHostCapability::Unsupported { reason, hint } => HostCapability::Unsupported {
            reason: reason.clone(),
            hint: hint.clone(),
        },
    }
}

pub(super) fn command_exists(command: &str) -> bool {
    Command::new("sh")
        .args(["-c", &format!("command -v {command} >/dev/null 2>&1")])
        .status()
        .is_ok_and(|status| status.success())
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
