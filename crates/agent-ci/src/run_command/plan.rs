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
