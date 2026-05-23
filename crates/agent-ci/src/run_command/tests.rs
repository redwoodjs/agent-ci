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
        pause_on_failure: true,
        ..RunArgs::default()
    };

    let plan = plan_run(&args, &repo).unwrap();

    assert_eq!(plan.repo_root, repo);
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
    let seed = dtu_job_seed_for_planned_job(&plan, workflow, job, "owner/repo", BTreeMap::new());

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

    assert!(failure_hint("tool: command not found", &repo, &working_dir, &env).is_none());
    assert!(
        failure_hint(
            "tar: bin/npm: Cannot open: Permission denied",
            &repo,
            &working_dir,
            &env
        )
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

#[test]
fn fixture_plan_contracts_match_snapshots() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let plans_dir = manifest.join("fixtures/plans");
    let mut entries = fs::read_dir(&plans_dir)
        .expect("fixture plans directory should exist")
        .collect::<Result<Vec<_>, _>>()
        .expect("fixture plans should be readable");
    entries.sort_by_key(|entry| entry.path());
    assert!(entries.len() >= 10, "expected at least 10 plan fixtures");

    for entry in entries {
        let expected: serde_json::Value = serde_json::from_slice(
            &fs::read(entry.path()).expect("fixture plan should be readable"),
        )
        .expect("fixture plan should be valid JSON");
        let workflow_name = expected
            .get("workflow")
            .and_then(serde_json::Value::as_str)
            .expect("fixture plan should name workflow");
        let mut args = RunArgs::default();
        args.no_matrix = expected
            .get("args")
            .and_then(|args| args.get("noMatrix"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let workflow_path = manifest.join("fixtures/workflows").join(workflow_name);
        let workflow = parse_workflow_file(&workflow_path).expect("fixture workflow should parse");
        let plan = plan_workflow_document(&args, &workflow, 1);
        let actual = plan_fixture_snapshot(&plan);
        assert_eq!(
            actual, expected["plan"],
            "fixture mismatch for {workflow_name}"
        );
    }
}

fn plan_fixture_snapshot(plan: &WorkflowRunPlan) -> serde_json::Value {
    serde_json::json!({
        "jobs": plan.jobs.iter().map(|job| serde_json::json!({
            "id": job.id,
            "runnerName": job.runner_name,
            "target": fixture_target(&job.target),
            "needs": job.needs,
            "if": job.if_condition,
            "matrix": job.matrix_context,
            "outputs": job.outputs.keys().cloned().collect::<Vec<_>>(),
            "services": job.services.iter().map(|service| service.id.clone()).collect::<Vec<_>>(),
            "container": job.container.as_ref().map(|container| container.image.clone()),
        })).collect::<Vec<_>>(),
        "schedule": plan.schedule,
    })
}

fn fixture_target(target: &PlannedJobTarget) -> String {
    match target {
        PlannedJobTarget::Linux { runs_on } => format!("linux:{runs_on}"),
        PlannedJobTarget::MacOs { runs_on } => format!("macos:{runs_on}"),
        PlannedJobTarget::ReusableWorkflow { uses } => format!("reusable:{uses}"),
        PlannedJobTarget::Unknown => "unknown".to_owned(),
    }
}
