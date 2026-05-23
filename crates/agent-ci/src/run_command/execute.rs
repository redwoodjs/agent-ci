use super::*;

pub(super) fn write_plan_summary(plan: &RunPlan, stdout: &mut impl Write) {
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

pub(super) fn print_human_summary(
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

pub(super) fn failure_content(result: &JobResult) -> String {
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

pub(super) fn tail_log_file(path: &Path, line_count: usize) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    let mut lines = content.lines().map(ToOwned::to_owned).collect::<Vec<_>>();
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
    let start = lines.len().saturating_sub(line_count);
    Some(format!("{}\n", lines[start..].join("\n")))
}

pub(super) fn failure_hint(
    content: &str,
    repo_root: &Path,
    working_dir: &Path,
    env: &BTreeMap<String, String>,
) -> Option<String> {
    let tool_cache_dir = working_dir.join("cache/toolcache");
    detect_runner_image_toolcache_hint(content, tool_cache_dir.to_str()).or_else(|| {
        let resolved = discover_runner_image(
            repo_root,
            env.get("AGENT_CI_RUNNER_IMAGE").map(String::as_str),
        );
        detect_runner_image_missing_tool_hint(content, &resolved)
    })
}

pub(super) fn format_duration(ms: u64) -> String {
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

pub(super) fn execute_run_plan(
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

pub(super) fn execute_run_plan_inner(
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
