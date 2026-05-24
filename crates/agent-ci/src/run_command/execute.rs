use super::*;
use std::sync::Arc;

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

fn execute_all_workflows_parallel(
    plan: &RunPlan,
    stdout: &mut impl Write,
    stderr: &mut impl Write,
    json_mode: bool,
) -> Result<i32, String> {
    let max_jobs = plan
        .max_jobs
        .map_or_else(default_max_concurrent_jobs, |value| {
            usize::try_from(value).unwrap_or(usize::MAX).max(1)
        });
    let jobs = plan
        .workflows
        .iter()
        .cloned()
        .enumerate()
        .map(|(index, workflow)| {
            let sub_plan = RunPlan {
                repo_root: plan.repo_root.clone(),
                effective_sha: plan.effective_sha.clone(),
                selection: RunSelection::SingleWorkflow,
                workflows: vec![workflow],
                pause_on_failure: plan.pause_on_failure,
                no_matrix: plan.no_matrix,
                // The outer worker pool is the global limiter for --all. Each
                // workflow advances one job at a time so active jobs stay under
                // the same cap TypeScript applies across workflow fan-out.
                max_jobs: Some(1),
            };
            (index, sub_plan)
        })
        .collect::<Vec<_>>();

    let outcomes = agent_ci_runtime::wave::run_concurrent_workers(
        max_jobs,
        jobs,
        move |_, sub_plan, _tx| {
            let mut out = Vec::new();
            let mut err = Vec::new();
            let status = execute_run_plan_inner(&sub_plan, &mut out, &mut err, json_mode)?;
            Ok((status, out, err))
        },
        |_: ()| {},
    )?;

    let mut failed = false;
    for (_, (status, out, err)) in outcomes {
        failed |= status != 0;
        stdout.write_all(&out).map_err(|err| err.to_string())?;
        stderr.write_all(&err).map_err(|err| err.to_string())?;
    }
    Ok(if failed { 1 } else { 0 })
}

pub(super) fn execute_run_plan_inner(
    plan: &RunPlan,
    stdout: &mut impl Write,
    stderr: &mut impl Write,
    json_mode: bool,
) -> Result<i32, String> {
    if matches!(plan.selection, RunSelection::AllRelevant { .. }) && plan.workflows.len() > 1 {
        return execute_all_workflows_parallel(plan, stdout, stderr, json_mode);
    }

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
    let mut docker_socket: Option<DockerSocket> = None;
    let mut extra_hosts: Option<Vec<String>> = None;
    let macos_capability = current_macos_vm_host_capability();
    let max_jobs = plan
        .max_jobs
        .map_or_else(default_max_concurrent_jobs, |value| {
            usize::try_from(value).unwrap_or(usize::MAX).max(1)
        });

    let mut completed_results = BTreeMap::<String, JobResultStatus>::new();
    let mut completed_outputs = BTreeMap::<String, BTreeMap<String, String>>::new();
    let mut job_results = Vec::<JobResult>::new();
    let mut any_failed = false;

    for workflow in &plan.workflows {
        for wave in &workflow.schedule {
            let mut wave_jobs = Vec::new();

            for (index, scheduled) in wave.iter().enumerate() {
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

                let route = execution_route_for_job(job, &macos_capability);
                if let JobExecutionRoute::Skip { reason } = route {
                    let _ = writeln!(
                        stderr,
                        "[Agent CI] Skipping '{}': {reason}",
                        job.display_name
                    );
                    completed_results.insert(job.id.clone(), JobResultStatus::Skipped);
                    continue;
                }

                wave_jobs.push(WaveJob {
                    index,
                    job: job.clone(),
                    route,
                    needs_context: needs_context_for_job(
                        job,
                        &completed_results,
                        &completed_outputs,
                    ),
                });
            }

            if wave_jobs.is_empty() {
                continue;
            }

            if wave_jobs
                .iter()
                .any(|wave_job| matches!(wave_job.route, JobExecutionRoute::Linux))
            {
                if image.is_none() {
                    let resolved = discover_runner_image(
                        &plan.repo_root,
                        process_env.get("AGENT_CI_RUNNER_IMAGE").map(String::as_str),
                    );
                    image = Some(ensure_runner_image(&mut docker_runtime, &resolved)?);
                }
                if docker_socket.is_none() {
                    docker_socket = Some(
                        resolve_docker_socket(&DockerSocketProbe::from_process())
                            .map_err(|err| err.to_string())?,
                    );
                }
                if extra_hosts.is_none() {
                    extra_hosts = Some(
                        resolve_docker_extra_hosts(&process_env, &dtu_host).unwrap_or_default(),
                    );
                }
            }

            let shared = Arc::new(SharedExecutionContext {
                run_plan: plan.clone(),
                workflow: workflow.clone(),
                working_dir: working_dir.clone(),
                logs_dir: logs_dir.clone(),
                process_env: process_env.clone(),
                github_repo: github_repo.clone(),
                dtu_url: dtu_url.clone(),
                dtu_container_url: dtu_container_url.clone(),
                dtu_port: dtu_port.clone(),
                docker_api_url: docker_api_url.clone(),
                repo_url: repo_url.clone(),
                dtu_host: dtu_host.clone(),
                image: image.clone(),
                docker_socket: docker_socket.clone(),
                extra_hosts: extra_hosts.clone().unwrap_or_default(),
            });

            let outcomes =
                execute_wave_jobs(shared, wave_jobs, max_jobs, stdout, stderr, json_mode)?;

            for outcome in outcomes {
                any_failed |= !outcome.result.succeeded;
                completed_outputs.insert(outcome.job_id.clone(), outcome.outputs);
                completed_results.insert(outcome.job_id, outcome.status);
                job_results.push(outcome.result);
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
