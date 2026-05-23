use crate::RunArgs;
use crate::docker::{
    ContainerBindsOpts, ContainerCmdOpts, ContainerEnvOpts, DockerCliRuntime, DockerSocketProbe,
    build_container_binds, build_container_cmd, build_container_env, resolve_docker_api_url,
    resolve_docker_extra_hosts, resolve_docker_socket,
};
use crate::dtu::{DtuHttpClient, start_ephemeral_dtu};
use crate::env::resolve_repo_root;
use crate::expr::{
    ExpressionContext, RunnerContext, evaluate_job_if, expand_expressions,
    uses_status_check_function,
};
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
use crate::runner_image::{
    detect_missing_tool_hint as detect_runner_image_missing_tool_hint,
    detect_toolcache_hint as detect_runner_image_toolcache_hint, discover_runner_image,
    ensure_runner_image,
};
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

mod discovery;
mod events;
mod execute;
mod host;
mod macos_job;
mod plan;

use discovery::*;
use events::*;
use execute::*;
use host::*;
use macos_job::*;
use plan::*;

pub use discovery::{
    RunDiscoveryError, discover_all_workflows, discover_relevant_workflows, discover_workflow_run,
    get_changed_files, resolve_effective_sha, runnable_jobs,
};
pub use events::job_lifecycle_events;
pub use plan::{
    decide_job_run, dtu_job_seed_for_planned_job, execution_route_for_job, plan_all_workflows,
    plan_run, plan_workflow_document, runner_execution_plan_for_job, schedule_job_waves,
};

#[cfg(test)]
mod tests;
