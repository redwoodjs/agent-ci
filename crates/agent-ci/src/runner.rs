use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobExecutionPlan {
    pub workflow: String,
    pub job_id: String,
    pub runner_name: String,
    pub container_name: String,
    pub image: String,
    pub env: Vec<String>,
    pub binds: Vec<String>,
    pub extra_hosts: Vec<String>,
    pub command: Vec<String>,
    pub log_dir: PathBuf,
    pub signals_dir: PathBuf,
    pub services: Vec<ServiceSpec>,
    pub pause_on_failure: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DtuRunnerRegistration {
    pub runner_name: String,
    pub log_dir: PathBuf,
    pub timeline_dir: PathBuf,
    pub virtual_cache_patterns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DtuJobSeed {
    pub id: String,
    pub runner_name: String,
    pub name: String,
    pub workflow_name: String,
    pub repo_root: PathBuf,
    pub github_repo: String,
    pub head_sha: String,
    pub real_head_sha: String,
    pub runner_work_dir: Option<PathBuf>,
    pub runner_os: Option<String>,
    pub runner_arch: Option<String>,
    pub env: BTreeMap<String, String>,
    pub outputs: BTreeMap<String, String>,
    pub needs_context: BTreeMap<String, NeedContext>,
    pub container: Option<DtuJobContainer>,
    pub services: Vec<ServiceSpec>,
    pub matrix_context: Option<BTreeMap<String, String>>,
    pub steps: Vec<DtuJobStep>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DtuJobContainer {
    pub image: String,
    pub env: BTreeMap<String, String>,
    pub ports: Vec<String>,
    pub volumes: Vec<String>,
    pub options: Option<String>,
}

impl DtuJobContainer {
    fn to_payload(&self) -> Value {
        json!({
            "image": self.image,
            "env": self.env,
            "ports": self.ports,
            "volumes": self.volumes,
            "options": self.options,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NeedContext {
    pub result: String,
    pub outputs: BTreeMap<String, String>,
}

impl NeedContext {
    fn to_payload(&self) -> Value {
        json!({ "result": self.result, "outputs": self.outputs })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DtuJobStep {
    pub name: String,
    pub context_name: Option<String>,
    pub run: Option<String>,
    pub uses: Option<String>,
    pub condition: Option<String>,
    pub shell: Option<String>,
    pub working_directory: Option<String>,
    pub env: BTreeMap<String, String>,
    pub with: BTreeMap<String, String>,
}

impl DtuJobSeed {
    pub fn to_payload(&self) -> Value {
        json!({
            "id": self.id,
            "runnerName": self.runner_name,
            "name": self.name,
            "workflowName": self.workflow_name,
            "repoRoot": self.repo_root,
            "githubRepo": self.github_repo,
            "headSha": self.head_sha,
            "realHeadSha": self.real_head_sha,
            "runnerWorkDir": self.runner_work_dir,
            "runnerOs": self.runner_os,
            "runnerArch": self.runner_arch,
            "env": self.env,
            "outputs": self.outputs,
            "needs": self.needs_context.iter().map(|(key, value)| (key.clone(), value.to_payload())).collect::<serde_json::Map<_, _>>(),
            "container": self.container.as_ref().map(DtuJobContainer::to_payload),
            "services": self.services.iter().map(ServiceSpec::to_payload).collect::<Vec<_>>(),
            "matrix": self.matrix_context.clone().unwrap_or_default(),
            "repository": {
                "full_name": self.github_repo,
                "name": self.github_repo.split('/').next_back().unwrap_or(&self.github_repo),
                "owner": { "login": self.github_repo.split('/').next().unwrap_or("local") },
                "default_branch": "main",
            },
            "steps": self.steps.iter().map(DtuJobStep::to_payload).collect::<Vec<_>>(),
        })
    }
}

impl DtuJobStep {
    pub fn to_payload(&self) -> Value {
        let mut payload = json!({ "name": self.name });
        if let Some(context_name) = &self.context_name {
            payload["ContextName"] = Value::String(context_name.clone());
        }
        if let Some(run) = &self.run {
            let script = apply_shell_override(run, self.shell.as_deref());
            let mut inputs = serde_json::Map::new();
            inputs.insert("script".to_owned(), Value::String(script));
            if let Some(working_directory) = &self.working_directory {
                inputs.insert(
                    "workingDirectory".to_owned(),
                    Value::String(working_directory.clone()),
                );
            }
            payload["run"] = Value::String(run.clone());
            payload["Inputs"] = Value::Object(inputs);
        }
        if let Some(uses) = &self.uses {
            payload["uses"] = Value::String(uses.clone());
        }
        if let Some(condition) = &self.condition {
            payload["condition"] = Value::String(normalize_step_condition(condition));
        }
        if !self.env.is_empty() {
            payload["Env"] = json!(self.env);
        }
        if self.run.is_none() && !self.with.is_empty() {
            payload["Inputs"] = json!(self.with);
        }
        payload
    }
}

fn apply_shell_override(script: &str, shell: Option<&str>) -> String {
    let Some(shell) = shell.map(str::trim).filter(|shell| !shell.is_empty()) else {
        return script.to_owned();
    };
    let invocation = match shell {
        "sh" => "sh -e",
        "python" => "python3",
        "pwsh" => "pwsh -NoLogo -NoProfile -NonInteractive -Command -",
        _ => return script.to_owned(),
    };
    let delimiter = "__AGENT_CI_SHELL_WRAP_EOF__";
    format!("{invocation} <<'{delimiter}'\n{script}\n{delimiter}")
}

fn normalize_step_condition(condition: &str) -> String {
    condition
        .trim()
        .strip_prefix("${{")
        .and_then(|value| value.strip_suffix("}}"))
        .map(str::trim)
        .unwrap_or_else(|| condition.trim())
        .to_owned()
}

pub fn wrap_pause_on_failure_steps(steps: &mut [DtuJobStep]) {
    for (index, step) in steps.iter_mut().enumerate() {
        if let Some(script) = step.run.as_deref() {
            let script = apply_shell_override(script, step.shell.as_deref());
            step.run = Some(wrap_pause_on_failure_script(&script, &step.name, index + 1));
            step.shell = None;
        }
    }
}

pub fn wrap_pause_on_failure_script(script: &str, step_name: &str, step_index: usize) -> String {
    let safe_name = step_name.replace('\'', "'\\''");
    format!(
        r#"__SIGNALS="/tmp/agent-ci-signals"
mkdir -p "$__SIGNALS"
__STEP_INDEX={step_index}
# ── from-step skip logic ──
if [ -f "$__SIGNALS/from-step" ]; then
  __FROM_STEP=$(cat "$__SIGNALS/from-step")
  if [ "$__FROM_STEP" != '*' ] && [ "$__STEP_INDEX" -lt "$__FROM_STEP" ] 2>/dev/null; then
    echo "Skipping step $__STEP_INDEX (rewind target: step $__FROM_STEP)"
    exit 0
  fi
  rm -f "$__SIGNALS/from-step"
  echo "Resuming from step $__STEP_INDEX."
fi
__ATTEMPT=0
while true; do
  __ATTEMPT=$((__ATTEMPT + 1))
  set +e
  (
{script}
  ) > "$__SIGNALS/step-output" 2>&1
  __EC=$?
  cat "$__SIGNALS/step-output"
  set -e
  if [ $__EC -eq 0 ]; then exit 0; fi
  printf '%s\n%s\n%s' '{safe_name}' "$__ATTEMPT" "$__STEP_INDEX" > "$__SIGNALS/paused"
  echo "::error::Step failed (exit $__EC). Paused — waiting for retry signal."
  while [ ! -f "$__SIGNALS/retry" ] && [ ! -f "$__SIGNALS/abort" ]; do sleep 1; done
  if [ -f "$__SIGNALS/abort" ]; then rm -f "$__SIGNALS/abort" "$__SIGNALS/paused"; exit $__EC; fi
  if [ -f "$__SIGNALS/from-step" ]; then
    __FROM_STEP=$(cat "$__SIGNALS/from-step")
    if [ "$__FROM_STEP" = '*' ]; then
      touch "$__SIGNALS/restart"
      rm -f "$__SIGNALS/retry" "$__SIGNALS/paused"
      exit 86
    fi
    if [ "$__FROM_STEP" -lt "$__STEP_INDEX" ] 2>/dev/null; then
      touch "$__SIGNALS/restart"
      rm -f "$__SIGNALS/retry" "$__SIGNALS/paused"
      exit 86
    fi
    if [ "$__FROM_STEP" -gt "$__STEP_INDEX" ] 2>/dev/null; then
      rm -f "$__SIGNALS/retry" "$__SIGNALS/paused"
      exit 0
    fi
    rm -f "$__SIGNALS/from-step"
  fi
  rm -f "$__SIGNALS/retry" "$__SIGNALS/paused"
  echo "Retrying step..."
done"#
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceSpec {
    pub id: String,
    pub image: String,
    pub env: Vec<String>,
    pub ports: BTreeMap<String, String>,
    pub options: Option<String>,
    pub health_cmd: Option<String>,
}

impl ServiceSpec {
    fn to_payload(&self) -> Value {
        let env = self
            .env
            .iter()
            .filter_map(|entry| entry.split_once('='))
            .map(|(key, value)| (key.to_owned(), Value::String(value.to_owned())))
            .collect::<serde_json::Map<_, _>>();
        let ports = self
            .ports
            .iter()
            .map(|(host, container)| {
                if host.is_empty() {
                    Value::String(container.clone())
                } else {
                    Value::String(format!("{host}:{container}"))
                }
            })
            .collect::<Vec<_>>();
        json!({
            "id": self.id,
            "image": self.image,
            "env": env,
            "ports": ports,
            "volumes": Vec::<String>::new(),
            "options": self.options,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartedService {
    pub id: String,
    pub container_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerExit {
    pub code: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobResult {
    pub name: String,
    pub workflow: String,
    pub succeeded: bool,
    pub paused: bool,
    pub duration_ms: u64,
    pub failed_step: Option<String>,
    pub debug_log_path: Option<PathBuf>,
    pub steps: Vec<StepResult>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StepResult {
    pub name: String,
    pub status: StepStatus,
    pub log_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StepStatus {
    Passed,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PausedSignal {
    pub step: Option<String>,
    pub attempt: Option<u32>,
    pub step_index: Option<u32>,
}

impl PausedSignal {
    pub fn from_content(content: &str) -> Self {
        let mut lines = content.lines();
        let step = lines
            .next()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        let attempt = lines.next().and_then(|value| value.trim().parse().ok());
        let step_index = lines.next().and_then(|value| value.trim().parse().ok());
        Self {
            step,
            attempt,
            step_index,
        }
    }
}

pub fn read_paused_signal(signals_dir: &Path) -> Option<PausedSignal> {
    fs::read_to_string(signals_dir.join("paused"))
        .ok()
        .map(|content| PausedSignal::from_content(&content))
}

pub trait DtuControlPlane {
    fn register_runner(&mut self, registration: &DtuRunnerRegistration) -> Result<(), String>;
    fn seed_job(&mut self, seed: &DtuJobSeed) -> Result<(), String>;
}

pub trait ContainerRuntime {
    fn create_network(&mut self, network: &str) -> Result<(), String>;
    fn remove_network(&mut self, network: &str) -> Result<(), String>;
    fn start_service(
        &mut self,
        service: &ServiceSpec,
        network: &str,
    ) -> Result<StartedService, String>;
    fn wait_service_healthy(&mut self, service: &StartedService) -> Result<(), String>;
    fn remove_service(&mut self, service: &StartedService) -> Result<(), String>;
    fn start_runner(&mut self, plan: &JobExecutionPlan, network: &str) -> Result<(), String>;
    fn stream_runner_logs(
        &mut self,
        runner_name: &str,
        signals_dir: Option<&Path>,
        sink: &mut dyn Write,
        on_pause: &mut dyn FnMut(PausedSignal),
    ) -> Result<(), String>;
    fn wait_runner(&mut self, runner_name: &str) -> Result<ContainerExit, String>;
    fn remove_runner(&mut self, runner_name: &str) -> Result<(), String>;
    fn resume_runner(
        &mut self,
        runner_name: &str,
        from_step: Option<RetryFromStep>,
    ) -> Result<ContainerExit, String>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryFromStep {
    FailedStep,
    Step(u32),
    Start,
}

pub fn execute_registered_runner_job(
    dtu: &mut impl DtuControlPlane,
    runtime: &mut impl ContainerRuntime,
    plan: &JobExecutionPlan,
    seed: &DtuJobSeed,
) -> Result<JobResult, String> {
    execute_registered_runner_job_with_pause_observer(dtu, runtime, plan, seed, &mut |_| {})
}

pub fn execute_registered_runner_job_with_pause_observer(
    dtu: &mut impl DtuControlPlane,
    runtime: &mut impl ContainerRuntime,
    plan: &JobExecutionPlan,
    seed: &DtuJobSeed,
    on_pause: &mut dyn FnMut(PausedSignal),
) -> Result<JobResult, String> {
    let mut attempt = 1_u32;
    loop {
        dtu.register_runner(&DtuRunnerRegistration {
            runner_name: plan.runner_name.clone(),
            log_dir: plan.log_dir.clone(),
            timeline_dir: plan.log_dir.clone(),
            virtual_cache_patterns: default_virtual_cache_patterns(),
        })?;
        let mut attempt_seed = seed.clone();
        if attempt > 1 {
            attempt_seed.id = format!("{}-retry-{attempt}", seed.id);
        }
        dtu.seed_job(&attempt_seed)?;
        let result = execute_job_with_pause_observer(runtime, plan, on_pause)?;
        if restart_requested(&plan.signals_dir) {
            let _ = fs::remove_file(plan.signals_dir.join("restart"));
            attempt += 1;
            continue;
        }
        return Ok(result);
    }
}

fn default_virtual_cache_patterns() -> Vec<String> {
    vec!["pnpm".to_owned(), "npm".to_owned(), "yarn".to_owned()]
}

pub fn execute_job(
    runtime: &mut impl ContainerRuntime,
    plan: &JobExecutionPlan,
) -> Result<JobResult, String> {
    execute_job_with_pause_observer(runtime, plan, &mut |_| {})
}

pub fn execute_job_with_pause_observer(
    runtime: &mut impl ContainerRuntime,
    plan: &JobExecutionPlan,
    on_pause: &mut dyn FnMut(PausedSignal),
) -> Result<JobResult, String> {
    let started = Instant::now();
    fs::create_dir_all(&plan.log_dir).map_err(|err| err.to_string())?;
    fs::create_dir_all(&plan.signals_dir).map_err(|err| err.to_string())?;
    let network = format!("agent-ci-{}", plan.container_name);
    let mut started_services = Vec::new();
    let mut network_created = false;
    let mut runner_started = false;

    let result = (|| -> Result<JobResult, String> {
        runtime.create_network(&network)?;
        network_created = true;

        for service in &plan.services {
            let started = runtime.start_service(service, &network)?;
            started_services.push(started);
            let started_ref = started_services.last().expect("service just pushed");
            runtime.wait_service_healthy(started_ref)?;
        }

        runtime.start_runner(plan, &network)?;
        runner_started = true;
        let output_log_path = plan.log_dir.join("output.log");
        let mut output_log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&output_log_path)
            .map_err(|err| err.to_string())?;
        runtime.stream_runner_logs(
            &plan.container_name,
            plan.pause_on_failure.then_some(plan.signals_dir.as_path()),
            &mut output_log,
            on_pause,
        )?;
        let exit = runtime.wait_runner(&plan.container_name)?;

        build_job_result_from_logs(plan, exit.code == 0, started.elapsed().as_millis() as u64)
    })();

    let preserve_resources = plan.signals_dir.join("paused").exists();
    let mut cleanup_errors = Vec::new();
    if !preserve_resources {
        if runner_started && let Err(err) = runtime.remove_runner(&plan.container_name) {
            cleanup_errors.push(err);
        }
        for service in started_services.iter().rev() {
            if let Err(err) = runtime.remove_service(service) {
                cleanup_errors.push(err);
            }
        }
        if network_created && let Err(err) = runtime.remove_network(&network) {
            cleanup_errors.push(err);
        }
        if !restart_requested(&plan.signals_dir) {
            let _ = fs::remove_dir_all(&plan.signals_dir);
        }
    }

    match (result, cleanup_errors.is_empty()) {
        (Ok(result), true) => {
            write_job_summary(plan, &result)?;
            Ok(result)
        }
        (Ok(_), false) => Err(format!(
            "runner cleanup failed: {}",
            cleanup_errors.join("; ")
        )),
        (Err(err), true) => Err(err),
        (Err(err), false) => Err(format!(
            "{err}; cleanup also failed: {}",
            cleanup_errors.join("; ")
        )),
    }
}

pub fn retry_paused_job(
    runtime: &mut impl ContainerRuntime,
    runner_name: &str,
    signals_dir: &Path,
    from_step: Option<RetryFromStep>,
) -> Result<ContainerExit, String> {
    if !signals_dir.join("paused").exists() {
        return Err(format!("Runner '{runner_name}' is not currently paused"));
    }
    if let Some(from_step) = from_step {
        fs::write(
            signals_dir.join("from-step"),
            from_step_signal_value(from_step),
        )
        .map_err(|err| err.to_string())?;
    }
    fs::write(signals_dir.join("retry"), "").map_err(|err| err.to_string())?;
    let exit = runtime.resume_runner(runner_name, from_step)?;
    let _ = fs::remove_file(signals_dir.join("paused"));
    Ok(exit)
}

pub fn abort_paused_job(
    runtime: &mut impl ContainerRuntime,
    runner_name: &str,
    signals_dir: &Path,
) -> Result<(), String> {
    if !signals_dir.join("paused").exists() {
        return Err(format!("Runner '{runner_name}' is not currently paused"));
    }
    fs::write(signals_dir.join("abort"), "").map_err(|err| err.to_string())?;
    runtime.remove_runner(runner_name)?;
    let _ = fs::remove_dir_all(signals_dir);
    Ok(())
}

fn restart_requested(signals_dir: &Path) -> bool {
    signals_dir.join("restart").exists()
}

fn from_step_signal_value(from_step: RetryFromStep) -> String {
    match from_step {
        RetryFromStep::FailedStep => String::new(),
        RetryFromStep::Step(step) => step.to_string(),
        RetryFromStep::Start => "*".to_owned(),
    }
}

fn build_job_result_from_logs(
    plan: &JobExecutionPlan,
    succeeded: bool,
    duration_ms: u64,
) -> Result<JobResult, String> {
    let timeline_path = plan.log_dir.join("timeline.json");
    let steps = parse_timeline_steps(&timeline_path);
    let timeline_failed = steps.iter().any(|step| step.status == StepStatus::Failed)
        || parse_timeline_job_failed(&timeline_path);
    let succeeded = succeeded && !timeline_failed;
    let failed_step = steps
        .iter()
        .find(|step| step.status == StepStatus::Failed)
        .map(|step| step.name.clone())
        .or_else(|| (!succeeded).then(|| "unknown".to_owned()));

    Ok(JobResult {
        name: plan.job_id.clone(),
        workflow: plan.workflow.clone(),
        succeeded,
        paused: false,
        duration_ms,
        failed_step,
        debug_log_path: Some(plan.log_dir.join("debug.log")),
        steps,
    })
}

fn parse_timeline_job_failed(path: &Path) -> bool {
    let Ok(content) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(records) = serde_json::from_str::<Value>(&content) else {
        return false;
    };
    records.as_array().into_iter().flatten().any(|record| {
        let record_type = record
            .get("type")
            .or_else(|| record.get("Type"))
            .and_then(Value::as_str);
        if record_type != Some("Job") {
            return false;
        }
        record
            .get("result")
            .or_else(|| record.get("Result"))
            .or_else(|| record.get("state"))
            .and_then(Value::as_str)
            .is_some_and(|result| {
                matches!(result.to_ascii_lowercase().as_str(), "failed" | "failure")
            })
    })
}

pub fn parse_timeline_steps(path: &Path) -> Vec<StepResult> {
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(records) = serde_json::from_str::<Value>(&content) else {
        return Vec::new();
    };
    let records = records.as_array().cloned().unwrap_or_default();
    let steps_dir = path.parent().map(|dir| dir.join("steps"));
    records
        .into_iter()
        .filter_map(|record| {
            let record_type = record
                .get("type")
                .or_else(|| record.get("Type"))
                .and_then(Value::as_str);
            if record_type != Some("Task") {
                return None;
            }
            let name = record
                .get("name")
                .or_else(|| record.get("Name"))
                .and_then(Value::as_str)?;
            let result = record
                .get("result")
                .or_else(|| record.get("Result"))
                .or_else(|| record.get("state"))
                .and_then(Value::as_str)
                .unwrap_or("succeeded");
            let status = match result.to_ascii_lowercase().as_str() {
                "failed" | "failure" => StepStatus::Failed,
                "skipped" => StepStatus::Skipped,
                _ => StepStatus::Passed,
            };
            let log_path = steps_dir.as_ref().and_then(|steps_dir| {
                step_log_candidates(&record, name)
                    .into_iter()
                    .map(|candidate| steps_dir.join(format!("{candidate}.log")))
                    .find(|candidate| candidate.exists())
            });
            Some(StepResult {
                name: name.to_owned(),
                status,
                log_path,
            })
        })
        .collect()
}

fn step_log_candidates(record: &Value, name: &str) -> Vec<String> {
    let mut candidates = vec![sanitize_step_log_name(name)];
    if let Some(id) = record.get("id").and_then(Value::as_str) {
        candidates.push(id.to_owned());
    }
    if let Some(log_id) = record
        .get("log")
        .and_then(|log| log.get("id"))
        .and_then(|id| {
            id.as_str()
                .map(ToOwned::to_owned)
                .or_else(|| id.as_u64().map(|id| id.to_string()))
        })
    {
        candidates.push(log_id);
    }
    candidates
}

fn sanitize_step_log_name(name: &str) -> String {
    let mut result = String::new();
    let mut previous_dash = false;
    for ch in name.chars() {
        let mapped = if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-') {
            ch
        } else {
            '-'
        };
        if mapped == '-' {
            if previous_dash {
                continue;
            }
            previous_dash = true;
        } else {
            previous_dash = false;
        }
        result.push(mapped);
        if result.len() >= 80 {
            break;
        }
    }
    result.trim_matches('-').to_owned()
}

fn write_job_summary(plan: &JobExecutionPlan, result: &JobResult) -> Result<(), String> {
    let summary_path = plan.log_dir.join("summary.json");
    let json = serde_json::to_string_pretty(result).map_err(|err| err.to_string())?;
    fs::write(summary_path, format!("{json}\n")).map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[derive(Default)]
    struct FakeRuntime {
        calls: Vec<String>,
        exit_code: i32,
        logs: Vec<String>,
        fail_start_runner: bool,
    }

    #[derive(Default)]
    struct FakeDtu {
        calls: Vec<String>,
        registrations: Vec<DtuRunnerRegistration>,
        seeds: Vec<DtuJobSeed>,
    }

    impl DtuControlPlane for FakeDtu {
        fn register_runner(&mut self, registration: &DtuRunnerRegistration) -> Result<(), String> {
            self.calls
                .push(format!("register {}", registration.runner_name));
            self.registrations.push(registration.clone());
            Ok(())
        }

        fn seed_job(&mut self, seed: &DtuJobSeed) -> Result<(), String> {
            self.calls.push(format!("seed {}", seed.id));
            self.seeds.push(seed.clone());
            Ok(())
        }
    }

    impl ContainerRuntime for FakeRuntime {
        fn create_network(&mut self, network: &str) -> Result<(), String> {
            self.calls.push(format!("create-network {network}"));
            Ok(())
        }

        fn remove_network(&mut self, network: &str) -> Result<(), String> {
            self.calls.push(format!("remove-network {network}"));
            Ok(())
        }

        fn start_service(
            &mut self,
            service: &ServiceSpec,
            network: &str,
        ) -> Result<StartedService, String> {
            self.calls
                .push(format!("start-service {} {network}", service.id));
            Ok(StartedService {
                id: service.id.clone(),
                container_name: format!("svc-{}", service.id),
            })
        }

        fn wait_service_healthy(&mut self, service: &StartedService) -> Result<(), String> {
            self.calls.push(format!("wait-service {}", service.id));
            Ok(())
        }

        fn remove_service(&mut self, service: &StartedService) -> Result<(), String> {
            self.calls.push(format!("remove-service {}", service.id));
            Ok(())
        }

        fn start_runner(&mut self, plan: &JobExecutionPlan, network: &str) -> Result<(), String> {
            self.calls
                .push(format!("start-runner {} {network}", plan.runner_name));
            if self.fail_start_runner {
                Err("start runner failed".to_owned())
            } else {
                Ok(())
            }
        }

        fn stream_runner_logs(
            &mut self,
            runner_name: &str,
            _signals_dir: Option<&Path>,
            sink: &mut dyn Write,
            _on_pause: &mut dyn FnMut(PausedSignal),
        ) -> Result<(), String> {
            self.calls.push(format!("stream {runner_name}"));
            for line in &self.logs {
                writeln!(sink, "{line}").map_err(|err| err.to_string())?;
            }
            Ok(())
        }

        fn wait_runner(&mut self, runner_name: &str) -> Result<ContainerExit, String> {
            self.calls.push(format!("wait {runner_name}"));
            Ok(ContainerExit {
                code: self.exit_code,
            })
        }

        fn remove_runner(&mut self, runner_name: &str) -> Result<(), String> {
            self.calls.push(format!("remove-runner {runner_name}"));
            Ok(())
        }

        fn resume_runner(
            &mut self,
            runner_name: &str,
            from_step: Option<RetryFromStep>,
        ) -> Result<ContainerExit, String> {
            self.calls
                .push(format!("resume {runner_name} {from_step:?}"));
            Ok(ContainerExit {
                code: self.exit_code,
            })
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("agent-ci-rust-runner-{name}-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn plan(root: &Path, pause_on_failure: bool) -> JobExecutionPlan {
        JobExecutionPlan {
            workflow: "ci.yml".to_owned(),
            job_id: "test".to_owned(),
            runner_name: "agent-ci-1-j1".to_owned(),
            container_name: "agent-ci-1-j1".to_owned(),
            image: crate::runner_image::UPSTREAM_RUNNER_IMAGE.to_owned(),
            env: vec![],
            binds: vec![],
            extra_hosts: vec!["host.docker.internal:host-gateway".to_owned()],
            command: vec!["bash".to_owned(), "-lc".to_owned(), "echo ok".to_owned()],
            log_dir: root.join("logs"),
            signals_dir: root.join("signals"),
            services: vec![ServiceSpec {
                id: "postgres".to_owned(),
                image: "postgres:16".to_owned(),
                env: vec!["POSTGRES_PASSWORD=pw".to_owned()],
                ports: BTreeMap::from([("5432".to_owned(), "5432".to_owned())]),
                options: None,
                health_cmd: Some("pg_isready".to_owned()),
            }],
            pause_on_failure,
        }
    }

    fn seed(root: &Path) -> DtuJobSeed {
        DtuJobSeed {
            id: "job-1".to_owned(),
            runner_name: "agent-ci-1-j1".to_owned(),
            name: "test".to_owned(),
            workflow_name: "ci".to_owned(),
            repo_root: root.to_path_buf(),
            github_repo: "owner/repo".to_owned(),
            head_sha: "HEAD".to_owned(),
            real_head_sha: "abc123".to_owned(),
            runner_work_dir: None,
            runner_os: None,
            runner_arch: None,
            env: BTreeMap::new(),
            outputs: BTreeMap::new(),
            needs_context: BTreeMap::new(),
            container: None,
            services: Vec::new(),
            matrix_context: None,
            steps: vec![DtuJobStep {
                name: "Run".to_owned(),
                context_name: None,
                run: Some("echo hi".to_owned()),
                uses: None,
                condition: None,
                shell: None,
                working_directory: None,
                env: BTreeMap::new(),
                with: BTreeMap::new(),
            }],
        }
    }

    #[test]
    fn parses_timeline_steps_into_result_entries() {
        let root = temp_dir("timeline");
        let timeline = root.join("timeline.json");
        fs::write(
            &timeline,
            r#"[
              {"name":"ci","type":"Job","result":"succeeded"},
              {"name":"Set up job","type":"Task","result":"succeeded"},
              {"name":"Run tests","type":"Task","result":"failed"},
              {"name":"Upload","type":"Task","result":"skipped"}
            ]"#,
        )
        .unwrap();

        fs::create_dir_all(root.join("steps")).unwrap();
        fs::write(root.join("steps/Run-tests.log"), "failed output").unwrap();

        let steps = parse_timeline_steps(&timeline);

        assert_eq!(steps.len(), 3);
        assert_eq!(steps[0].status, StepStatus::Passed);
        assert_eq!(steps[1].status, StepStatus::Failed);
        assert_eq!(steps[1].log_path, Some(root.join("steps/Run-tests.log")));
        assert_eq!(steps[2].status, StepStatus::Skipped);
    }

    #[test]
    fn executes_job_starts_services_streams_logs_collects_results_and_cleans_up() {
        let root = temp_dir("success");
        let plan = plan(&root, false);
        fs::create_dir_all(&plan.log_dir).unwrap();
        fs::write(
            plan.log_dir.join("timeline.json"),
            r#"[{"name":"Run","type":"Task","result":"succeeded"}]"#,
        )
        .unwrap();
        let mut runtime = FakeRuntime {
            exit_code: 0,
            logs: vec!["hello".to_owned()],
            calls: vec![],
            ..FakeRuntime::default()
        };

        let result = execute_job(&mut runtime, &plan).unwrap();

        assert!(result.succeeded);
        assert!(!result.paused);
        assert_eq!(result.steps.len(), 1);
        assert_eq!(
            fs::read_to_string(plan.log_dir.join("output.log")).unwrap(),
            "hello\n"
        );
        assert!(plan.log_dir.join("summary.json").exists());
        assert_eq!(
            runtime.calls,
            vec![
                "create-network agent-ci-agent-ci-1-j1",
                "start-service postgres agent-ci-agent-ci-1-j1",
                "wait-service postgres",
                "start-runner agent-ci-1-j1 agent-ci-agent-ci-1-j1",
                "stream agent-ci-1-j1",
                "wait agent-ci-1-j1",
                "remove-runner agent-ci-1-j1",
                "remove-service postgres",
                "remove-network agent-ci-agent-ci-1-j1",
            ]
        );
    }

    #[test]
    fn failed_start_cleans_up_services_and_network() {
        let root = temp_dir("start-fail");
        let plan = plan(&root, false);
        fs::create_dir_all(&plan.log_dir).unwrap();
        let mut runtime = FakeRuntime {
            fail_start_runner: true,
            ..FakeRuntime::default()
        };

        let err = execute_job(&mut runtime, &plan).unwrap_err();

        assert_eq!(err, "start runner failed");
        assert_eq!(
            runtime.calls,
            vec![
                "create-network agent-ci-agent-ci-1-j1",
                "start-service postgres agent-ci-agent-ci-1-j1",
                "wait-service postgres",
                "start-runner agent-ci-1-j1 agent-ci-agent-ci-1-j1",
                "remove-service postgres",
                "remove-network agent-ci-agent-ci-1-j1",
            ]
        );
    }

    #[test]
    fn registered_runner_job_registers_seeds_starts_runner_and_collects_logs() {
        let root = temp_dir("registered");
        let plan = plan(&root, false);
        fs::create_dir_all(&plan.log_dir).unwrap();
        fs::write(
            plan.log_dir.join("timeline.json"),
            r#"[{"name":"Run","type":"Task","result":"succeeded"}]"#,
        )
        .unwrap();
        let seed = seed(&root);
        let mut dtu = FakeDtu::default();
        let mut runtime = FakeRuntime {
            exit_code: 0,
            logs: vec!["hello from runner".to_owned()],
            calls: vec![],
            ..FakeRuntime::default()
        };

        let result = execute_registered_runner_job(&mut dtu, &mut runtime, &plan, &seed).unwrap();

        assert!(result.succeeded);
        assert_eq!(plan.image, crate::runner_image::UPSTREAM_RUNNER_IMAGE);
        assert_eq!(dtu.calls, vec!["register agent-ci-1-j1", "seed job-1"]);
        assert_eq!(dtu.registrations[0].log_dir, plan.log_dir);
        assert_eq!(dtu.registrations[0].timeline_dir, plan.log_dir);
        assert_eq!(dtu.seeds[0], seed);
        assert_eq!(
            runtime.calls[3],
            "start-runner agent-ci-1-j1 agent-ci-agent-ci-1-j1"
        );
        assert_eq!(runtime.calls[4], "stream agent-ci-1-j1");
        assert_eq!(runtime.calls[5], "wait agent-ci-1-j1");
        assert_eq!(
            fs::read_to_string(plan.log_dir.join("output.log")).unwrap(),
            "hello from runner\n"
        );
    }

    #[test]
    fn wraps_script_steps_with_pause_retry_loop() {
        let mut steps = vec![
            DtuJobStep {
                name: "Build's step".to_owned(),
                context_name: None,
                run: Some("echo build && exit 1".to_owned()),
                uses: None,
                condition: None,
                shell: None,
                working_directory: None,
                env: BTreeMap::new(),
                with: BTreeMap::new(),
            },
            DtuJobStep {
                name: "checkout".to_owned(),
                context_name: None,
                run: None,
                uses: Some("actions/checkout@v4".to_owned()),
                condition: None,
                shell: None,
                working_directory: None,
                env: BTreeMap::new(),
                with: BTreeMap::new(),
            },
        ];

        wrap_pause_on_failure_steps(&mut steps);

        let script = steps[0].run.as_ref().unwrap();
        assert!(script.contains("/tmp/agent-ci-signals"));
        assert!(script.contains("__STEP_INDEX=1"));
        assert!(script.contains("echo build && exit 1"));
        assert!(script.contains("Build'\\''s step"));
        assert_eq!(steps[1].run, None);
    }

    #[test]
    fn dtu_job_seed_payload_contains_targeted_runner_and_script_step() {
        let root = temp_dir("seed-payload");
        let seed = seed(&root);

        let payload = seed.to_payload();

        assert_eq!(payload["id"], "job-1");
        assert_eq!(payload["runnerName"], "agent-ci-1-j1");
        assert_eq!(payload["repository"]["full_name"], "owner/repo");
        assert_eq!(payload["steps"][0]["name"], "Run");
        assert_eq!(payload["steps"][0]["run"], "echo hi");
    }

    #[test]
    fn failed_job_with_pause_cleans_up_when_no_step_wrapper_paused() {
        let root = temp_dir("pause");
        let plan = plan(&root, true);
        fs::create_dir_all(&plan.log_dir).unwrap();
        fs::write(
            plan.log_dir.join("timeline.json"),
            r#"[{"name":"Run tests","type":"Task","result":"failed"}]"#,
        )
        .unwrap();
        let mut runtime = FakeRuntime {
            exit_code: 1,
            logs: vec![],
            calls: vec![],
            ..FakeRuntime::default()
        };

        let result = execute_job(&mut runtime, &plan).unwrap();

        assert!(!result.succeeded);
        assert!(!result.paused);
        assert!(!plan.signals_dir.join("paused").exists());
        assert!(
            runtime
                .calls
                .iter()
                .any(|call| call.starts_with("remove-runner"))
        );
        assert!(
            runtime
                .calls
                .iter()
                .any(|call| call.starts_with("remove-service"))
        );
        assert!(
            runtime
                .calls
                .iter()
                .any(|call| call.starts_with("remove-network"))
        );
    }

    #[test]
    fn retry_paused_job_writes_retry_and_from_step_then_resumes() {
        let root = temp_dir("retry");
        let signals = root.join("signals");
        fs::create_dir_all(&signals).unwrap();
        fs::write(signals.join("paused"), "Run tests").unwrap();
        let mut runtime = FakeRuntime {
            exit_code: 0,
            logs: vec![],
            calls: vec![],
            ..FakeRuntime::default()
        };

        let exit = retry_paused_job(
            &mut runtime,
            "runner",
            &signals,
            Some(RetryFromStep::Step(3)),
        )
        .unwrap();

        assert_eq!(exit.code, 0);
        assert!(signals.join("retry").exists());
        assert_eq!(fs::read_to_string(signals.join("from-step")).unwrap(), "3");
        assert_eq!(runtime.calls, vec!["resume runner Some(Step(3))"]);
        assert!(!signals.join("paused").exists());
    }

    #[test]
    fn abort_paused_job_writes_abort_and_removes_runner() {
        let root = temp_dir("abort");
        let signals = root.join("signals");
        fs::create_dir_all(&signals).unwrap();
        fs::write(signals.join("paused"), "Run tests").unwrap();
        let mut runtime = FakeRuntime::default();

        abort_paused_job(&mut runtime, "runner", &signals).unwrap();

        assert_eq!(runtime.calls, vec!["remove-runner runner"]);
        assert!(!signals.exists());
    }
}
