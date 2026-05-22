use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

pub const DEFAULT_MACOS_IMAGE: &str = "ghcr.io/cirruslabs/macos-sequoia-xcode:latest";
pub const DEFAULT_MACOS_RUNNER_VERSION: &str = "2.331.0";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostCapability {
    Supported,
    Unsupported {
        reason: String,
        hint: Option<String>,
    },
}

pub fn check_macos_vm_host(
    platform: &str,
    arch: &str,
    has_tart: bool,
    has_sshpass: bool,
) -> HostCapability {
    if !matches!(platform, "darwin" | "macos") {
        return HostCapability::Unsupported {
            reason: format!("macOS VM runner requires a macOS host (got {platform})."),
            hint: None,
        };
    }
    if !matches!(arch, "arm64" | "aarch64") {
        return HostCapability::Unsupported {
            reason: format!("macOS VM runner requires an Apple Silicon host (got {arch})."),
            hint: Some(
                "Apple's Virtualization.framework does not support macOS guests on Intel Macs."
                    .to_owned(),
            ),
        };
    }
    if !has_tart {
        return HostCapability::Unsupported {
            reason: "macOS VM runner requires `tart` to be installed.".to_owned(),
            hint: Some("Install with: brew install cirruslabs/cli/tart".to_owned()),
        };
    }
    if !has_sshpass {
        return HostCapability::Unsupported {
            reason: "macOS VM runner requires `sshpass` to be installed.".to_owned(),
            hint: Some("Install with: brew install hudochenkov/sshpass/sshpass".to_owned()),
        };
    }
    HostCapability::Supported
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageResolution {
    pub image: String,
    pub exact: bool,
    pub matched_label: Option<String>,
}

pub fn resolve_macos_vm_image(labels: &[String], override_image: Option<&str>) -> ImageResolution {
    if let Some(image) = override_image
        .map(str::trim)
        .filter(|image| !image.is_empty())
    {
        return ImageResolution {
            image: image.to_owned(),
            exact: true,
            matched_label: None,
        };
    }
    for label in labels {
        if let Some(mapped) = label_to_image(label) {
            return ImageResolution {
                image: mapped.to_owned(),
                exact: true,
                matched_label: Some(label.clone()),
            };
        }
    }
    let matched_label = labels
        .iter()
        .find(|label| label.to_ascii_lowercase().starts_with("macos"))
        .or_else(|| labels.first())
        .cloned();
    ImageResolution {
        image: DEFAULT_MACOS_IMAGE.to_owned(),
        exact: false,
        matched_label,
    }
}

fn label_to_image(label: &str) -> Option<&'static str> {
    match label.to_ascii_lowercase().as_str() {
        "macos-13" => Some("ghcr.io/cirruslabs/macos-ventura-xcode:latest"),
        "macos-14" => Some("ghcr.io/cirruslabs/macos-sonoma-xcode:latest"),
        "macos-15" => Some("ghcr.io/cirruslabs/macos-sequoia-xcode:latest"),
        "macos-26" => Some("ghcr.io/cirruslabs/macos-tahoe-xcode:latest"),
        "macos-latest" | "macos" => Some("ghcr.io/cirruslabs/macos-sonoma-xcode:latest"),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
}

impl CommandSpec {
    fn new(program: impl Into<String>, args: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            program: program.into(),
            args: args.into_iter().map(Into::into).collect(),
        }
    }
}

pub fn tart_pull_args(image: &str) -> CommandSpec {
    CommandSpec::new("tart", ["pull", image])
}

pub fn tart_clone_args(base: &str, name: &str) -> CommandSpec {
    CommandSpec::new("tart", ["clone", base, name])
}

pub fn tart_run_args(name: &str, graphics: bool) -> CommandSpec {
    let mut args = vec!["run".to_owned()];
    if !graphics {
        args.push("--no-graphics".to_owned());
    }
    args.push(name.to_owned());
    CommandSpec::new("tart", args)
}

pub fn tart_ip_args(name: &str) -> CommandSpec {
    CommandSpec::new("tart", ["ip", name])
}

pub fn tart_stop_args(name: &str) -> CommandSpec {
    CommandSpec::new("tart", ["stop", name])
}

pub fn tart_delete_args(name: &str) -> CommandSpec {
    CommandSpec::new("tart", ["delete", name])
}

pub fn tart_list_args() -> CommandSpec {
    CommandSpec::new("tart", ["list", "--format", "json"])
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshCreds {
    pub user: String,
    pub password: String,
}

pub fn ssh_args(ip: &str, creds: &SshCreds, remote_cmd: &[String]) -> CommandSpec {
    let mut args = vec![
        "-p".to_owned(),
        creds.password.clone(),
        "ssh".to_owned(),
        "-o".to_owned(),
        "StrictHostKeyChecking=no".to_owned(),
        "-o".to_owned(),
        "UserKnownHostsFile=/dev/null".to_owned(),
        "-o".to_owned(),
        "LogLevel=ERROR".to_owned(),
        "-o".to_owned(),
        "ConnectTimeout=5".to_owned(),
        format!("{}@{ip}", creds.user),
    ];
    args.extend(remote_cmd.iter().cloned());
    CommandSpec::new("sshpass", args)
}

pub fn rsync_args(
    src: &str,
    dst: &str,
    creds: &SshCreds,
    exclude: &[String],
    delete: bool,
) -> CommandSpec {
    let rsync_rsh = format!(
        "sshpass -p {} ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR",
        creds.password
    );
    let mut args = vec!["-az".to_owned(), "-e".to_owned(), rsync_rsh];
    if delete {
        args.push("--delete".to_owned());
    }
    for pattern in exclude {
        args.push("--exclude".to_owned());
        args.push(pattern.clone());
    }
    args.push(src.to_owned());
    args.push(dst.to_owned());
    CommandSpec::new("rsync", args)
}

pub fn resolve_macos_runner_version(env_value: Option<&str>) -> String {
    env_value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_MACOS_RUNNER_VERSION)
        .to_owned()
}

pub fn macos_runner_tarball_url(version: &str) -> String {
    format!(
        "https://github.com/actions/runner/releases/download/v{version}/actions-runner-osx-arm64-{version}.tar.gz"
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedRunner {
    pub version: String,
    pub dir: PathBuf,
}

pub trait RunnerBinaryIo {
    fn download_to_file(&mut self, url: &str, dst: &Path) -> Result<(), String>;
    fn extract_tarball(&mut self, tarball: &Path, dst: &Path) -> Result<(), String>;
}

#[derive(Debug, Default)]
pub struct CommandRunnerBinaryIo;

impl RunnerBinaryIo for CommandRunnerBinaryIo {
    fn download_to_file(&mut self, url: &str, dst: &Path) -> Result<(), String> {
        let status = Command::new("curl")
            .args(["-fsSL", "-o"])
            .arg(dst)
            .arg(url)
            .status()
            .map_err(|err| format!("failed to run curl: {err}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("curl failed while downloading {url}"))
        }
    }

    fn extract_tarball(&mut self, tarball: &Path, dst: &Path) -> Result<(), String> {
        let status = Command::new("tar")
            .arg("-xzf")
            .arg(tarball)
            .arg("-C")
            .arg(dst)
            .status()
            .map_err(|err| format!("failed to run tar: {err}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("tar failed while extracting {}", tarball.display()))
        }
    }
}

pub fn ensure_macos_runner_binary(
    io: &mut impl RunnerBinaryIo,
    cache_root: &Path,
    version: &str,
) -> Result<CachedRunner, String> {
    let dir = cache_root.join(version);
    let marker = dir.join(".extracted");
    if marker.exists() && dir.join("run.sh").exists() {
        return Ok(CachedRunner {
            version: version.to_owned(),
            dir,
        });
    }

    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let tarball = dir.join(format!("actions-runner-osx-arm64-{version}.tar.gz"));
    if !tarball.exists() {
        io.download_to_file(&macos_runner_tarball_url(version), &tarball)?;
    }
    io.extract_tarball(&tarball, &dir)?;
    if !dir.join("run.sh").exists() {
        return Err(format!(
            "Extracted runner at {} does not contain run.sh — tarball structure changed?",
            dir.display()
        ));
    }
    fs::write(marker, "extracted\n").map_err(|err| err.to_string())?;
    Ok(CachedRunner {
        version: version.to_owned(),
        dir,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MacosVmJobResult {
    pub vm_name: String,
    pub ip: String,
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MacosVmJobPlan {
    pub vm_name: String,
    pub image: String,
    pub repo_root: PathBuf,
    pub local_runner_dir: PathBuf,
    pub remote_workspace: String,
    pub remote_runner_dir: String,
    pub remote_log_dir: String,
    pub local_log_dir: PathBuf,
    pub creds: SshCreds,
    pub dtu_url: String,
    pub runner_token: String,
    pub runner_labels: Vec<String>,
    pub job_script: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VmCommandResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

pub trait MacosVmRuntime {
    fn image_exists(&mut self, image: &str) -> Result<bool, String>;
    fn pull_image(&mut self, image: &str) -> Result<(), String>;
    fn clone_vm(&mut self, image: &str, name: &str) -> Result<(), String>;
    fn start_vm(&mut self, name: &str) -> Result<(), String>;
    fn get_ip(&mut self, name: &str) -> Result<Option<String>, String>;
    fn ssh_exec(
        &mut self,
        ip: &str,
        creds: &SshCreds,
        script: &str,
    ) -> Result<VmCommandResult, String>;
    fn rsync_to(
        &mut self,
        ip: &str,
        creds: &SshCreds,
        local_src: &Path,
        remote_dst: &str,
        exclude: &[String],
        delete: bool,
    ) -> Result<(), String>;
    fn rsync_from(
        &mut self,
        ip: &str,
        creds: &SshCreds,
        remote_src: &str,
        local_dst: &Path,
    ) -> Result<(), String>;
    fn stop_vm(&mut self, name: &str) -> Result<(), String>;
    fn delete_vm(&mut self, name: &str) -> Result<(), String>;
}

#[derive(Debug, Default)]
pub struct CommandMacosVmRuntime {
    children: BTreeMap<String, Child>,
}

impl CommandMacosVmRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    fn run_status(spec: CommandSpec) -> Result<(), String> {
        let output = Command::new(&spec.program)
            .args(&spec.args)
            .output()
            .map_err(|err| format!("failed to run {}: {err}", spec.program))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "{} failed: {}{}",
                spec.program,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            ))
        }
    }

    fn run_output(spec: CommandSpec) -> Result<VmCommandResult, String> {
        let output = Command::new(&spec.program)
            .args(&spec.args)
            .output()
            .map_err(|err| format!("failed to run {}: {err}", spec.program))?;
        Ok(VmCommandResult {
            code: output.status.code().unwrap_or(1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

impl MacosVmRuntime for CommandMacosVmRuntime {
    fn image_exists(&mut self, image: &str) -> Result<bool, String> {
        let result = Self::run_output(tart_list_args())?;
        if result.code != 0 {
            return Ok(false);
        }
        let escaped = image.replace('/', "\\/");
        Ok(result.stdout.contains(&format!("\"Name\" : \"{escaped}\""))
            || result.stdout.contains(&format!("\"Name\":\"{escaped}\""))
            || result.stdout.contains(&format!("\"Name\" : \"{image}\""))
            || result.stdout.contains(&format!("\"Name\":\"{image}\"")))
    }

    fn pull_image(&mut self, image: &str) -> Result<(), String> {
        Self::run_status(tart_pull_args(image))
    }

    fn clone_vm(&mut self, image: &str, name: &str) -> Result<(), String> {
        let _ = Self::run_status(tart_delete_args(name));
        Self::run_status(tart_clone_args(image, name))
    }

    fn start_vm(&mut self, name: &str) -> Result<(), String> {
        let spec = tart_run_args(name, false);
        let child = Command::new(&spec.program)
            .args(&spec.args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|err| format!("failed to start tart VM {name}: {err}"))?;
        self.children.insert(name.to_owned(), child);
        Ok(())
    }

    fn get_ip(&mut self, name: &str) -> Result<Option<String>, String> {
        let result = Self::run_output(tart_ip_args(name))?;
        if result.code != 0 {
            return Ok(None);
        }
        Ok(result
            .stdout
            .lines()
            .next()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned))
    }

    fn ssh_exec(
        &mut self,
        ip: &str,
        creds: &SshCreds,
        script: &str,
    ) -> Result<VmCommandResult, String> {
        Self::run_output(ssh_args(
            ip,
            creds,
            &["bash".to_owned(), "-lc".to_owned(), script.to_owned()],
        ))
    }

    fn rsync_to(
        &mut self,
        ip: &str,
        creds: &SshCreds,
        local_src: &Path,
        remote_dst: &str,
        exclude: &[String],
        delete: bool,
    ) -> Result<(), String> {
        let src = format!("{}/", local_src.display());
        let dst = format!("{}@{ip}:{}/", creds.user, remote_dst.trim_end_matches('/'));
        Self::run_status(rsync_args(&src, &dst, creds, exclude, delete))
    }

    fn rsync_from(
        &mut self,
        ip: &str,
        creds: &SshCreds,
        remote_src: &str,
        local_dst: &Path,
    ) -> Result<(), String> {
        fs::create_dir_all(local_dst).map_err(|err| err.to_string())?;
        let src = format!("{}@{ip}:{}/", creds.user, remote_src.trim_end_matches('/'));
        let dst = format!("{}/", local_dst.display());
        Self::run_status(rsync_args(&src, &dst, creds, &[], false))
    }

    fn stop_vm(&mut self, name: &str) -> Result<(), String> {
        if let Some(mut child) = self.children.remove(name) {
            let _ = child.kill();
        }
        match Self::run_status(tart_stop_args(name)) {
            Ok(()) => Ok(()),
            Err(err) if err.contains("is not running") => Ok(()),
            Err(err) => Err(err),
        }
    }

    fn delete_vm(&mut self, name: &str) -> Result<(), String> {
        Self::run_status(tart_delete_args(name))
    }
}

pub fn wait_for_ip(
    runtime: &mut impl MacosVmRuntime,
    vm_name: &str,
    max_attempts: usize,
) -> Result<String, String> {
    for _ in 0..max_attempts {
        if let Some(ip) = runtime.get_ip(vm_name)? {
            return Ok(ip);
        }
    }
    Err(format!("Timed out waiting for VM {vm_name} to get an IP"))
}

pub fn wait_for_ssh(
    runtime: &mut impl MacosVmRuntime,
    ip: &str,
    creds: &SshCreds,
    max_attempts: usize,
) -> Result<(), String> {
    for _ in 0..max_attempts {
        let result = runtime.ssh_exec(ip, creds, "true");
        if matches!(result, Ok(VmCommandResult { code: 0, .. })) {
            return Ok(());
        }
    }
    Err(format!("Timed out waiting for SSH on {ip}"))
}

pub fn apply_dns_override(
    runtime: &mut impl MacosVmRuntime,
    ip: &str,
    creds: &SshCreds,
    dns: &[String],
) -> Result<(), String> {
    let script = format!(
        "set -euo pipefail\necho \"{}\" | sudo -S networksetup -setdnsservers Ethernet {}\ndig +short +time=5 +tries=1 github.com >/dev/null\n",
        creds.password,
        dns.join(" ")
    );
    let result = runtime.ssh_exec(ip, creds, &script)?;
    if result.code != 0 {
        return Err(format!(
            "DNS override failed on {ip}: {}",
            if result.stderr.trim().is_empty() {
                result.stdout.trim()
            } else {
                result.stderr.trim()
            }
        ));
    }
    Ok(())
}

pub fn sync_repo_to_vm(
    runtime: &mut impl MacosVmRuntime,
    plan: &MacosVmJobPlan,
    ip: &str,
) -> Result<(), String> {
    let exclude = vec![
        ".git".to_owned(),
        "node_modules".to_owned(),
        "target".to_owned(),
    ];
    runtime.rsync_to(
        ip,
        &plan.creds,
        &plan.repo_root,
        &plan.remote_workspace,
        &exclude,
        true,
    )
}

pub fn build_macos_runner_script(plan: &MacosVmJobPlan) -> String {
    format!(
        r#"set -euo pipefail
mkdir -p {runner_dir} {log_dir}
cd {runner_dir}
# Credentials are pre-written by Agent CI to avoid config.sh network/bootstrap overhead.
{job_script}
"#,
        runner_dir = shell_escape(&plan.remote_runner_dir),
        log_dir = shell_escape(&plan.remote_log_dir),
        job_script = plan.job_script,
    )
}

pub fn execute_macos_vm_job(
    runtime: &mut impl MacosVmRuntime,
    plan: &MacosVmJobPlan,
) -> Result<MacosVmJobResult, String> {
    fs::create_dir_all(&plan.local_log_dir).map_err(|err| err.to_string())?;
    let mut cleanup_errors = Vec::new();
    let result = (|| {
        if !runtime.image_exists(&plan.image)? {
            runtime.pull_image(&plan.image)?;
        }
        runtime.clone_vm(&plan.image, &plan.vm_name)?;
        runtime.start_vm(&plan.vm_name)?;
        let ip = wait_for_ip(runtime, &plan.vm_name, 90)?;
        wait_for_ssh(runtime, &ip, &plan.creds, 80)?;
        apply_dns_override(
            runtime,
            &ip,
            &plan.creds,
            &["1.1.1.1".to_owned(), "8.8.8.8".to_owned()],
        )?;
        let mkdir_result = runtime.ssh_exec(
            &ip,
            &plan.creds,
            &format!(
                "set -e\nmkdir -p {} {} {}",
                shell_escape(&plan.remote_workspace),
                shell_escape(&plan.remote_runner_dir),
                shell_escape(&plan.remote_log_dir),
            ),
        )?;
        if mkdir_result.code != 0 {
            return Err(format!(
                "failed to prepare macOS VM directories: {}{}",
                mkdir_result.stdout, mkdir_result.stderr
            ));
        }
        sync_repo_to_vm(runtime, plan, &ip)?;
        runtime.rsync_to(
            &ip,
            &plan.creds,
            &plan.local_runner_dir,
            &plan.remote_runner_dir,
            &[],
            true,
        )?;
        let script = build_macos_runner_script(plan);
        let command = runtime.ssh_exec(&ip, &plan.creds, &script)?;
        runtime.rsync_from(&ip, &plan.creds, &plan.remote_log_dir, &plan.local_log_dir)?;
        Ok(MacosVmJobResult {
            vm_name: plan.vm_name.clone(),
            ip,
            code: command.code,
            stdout: command.stdout,
            stderr: command.stderr,
        })
    })();

    if let Err(err) = runtime.stop_vm(&plan.vm_name) {
        cleanup_errors.push(err);
    }
    if let Err(err) = runtime.delete_vm(&plan.vm_name) {
        cleanup_errors.push(err);
    }

    match (result, cleanup_errors.is_empty()) {
        (Ok(result), true) => Ok(result),
        (Ok(_), false) => Err(format!(
            "macOS VM cleanup failed: {}",
            cleanup_errors.join("; ")
        )),
        (Err(err), true) => Err(err),
        (Err(err), false) => Err(format!(
            "{err}; cleanup also failed: {}",
            cleanup_errors.join("; ")
        )),
    }
}

fn shell_escape(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub struct VmSemaphore {
    limit: usize,
    active: usize,
    waiters: VecDeque<usize>,
}

impl VmSemaphore {
    pub fn new(limit: usize) -> Result<Self, String> {
        if limit == 0 {
            return Err("Semaphore limit must be a positive integer, got 0".to_owned());
        }
        Ok(Self {
            limit,
            active: 0,
            waiters: VecDeque::new(),
        })
    }

    pub fn try_acquire(&mut self, ticket: usize) -> bool {
        if self.active < self.limit && self.waiters.front().is_none_or(|front| *front == ticket) {
            self.active += 1;
            if self.waiters.front() == Some(&ticket) {
                self.waiters.pop_front();
            }
            true
        } else {
            if !self.waiters.contains(&ticket) {
                self.waiters.push_back(ticket);
            }
            false
        }
    }

    pub fn release(&mut self) {
        if self.active > 0 {
            self.active -= 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("agent-ci-rust-macos-vm-{name}-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[derive(Default)]
    struct FakeBinaryIo {
        calls: Vec<String>,
        create_run_sh: bool,
    }

    impl RunnerBinaryIo for FakeBinaryIo {
        fn download_to_file(&mut self, url: &str, dst: &Path) -> Result<(), String> {
            self.calls.push(format!("download {url} {}", dst.display()));
            fs::write(dst, "tarball").map_err(|err| err.to_string())
        }

        fn extract_tarball(&mut self, tarball: &Path, dst: &Path) -> Result<(), String> {
            self.calls
                .push(format!("extract {} {}", tarball.display(), dst.display()));
            if self.create_run_sh {
                fs::write(dst.join("run.sh"), "#!/bin/sh\n").map_err(|err| err.to_string())?;
            }
            Ok(())
        }
    }

    #[derive(Default)]
    struct FakeVmRuntime {
        calls: Vec<String>,
        ips: Vec<Option<String>>,
        ssh_ready_after: usize,
        ssh_attempts: usize,
        job_code: i32,
    }

    impl MacosVmRuntime for FakeVmRuntime {
        fn image_exists(&mut self, image: &str) -> Result<bool, String> {
            self.calls.push(format!("image-exists {image}"));
            Ok(false)
        }

        fn pull_image(&mut self, image: &str) -> Result<(), String> {
            self.calls.push(format!("pull {image}"));
            Ok(())
        }

        fn clone_vm(&mut self, image: &str, name: &str) -> Result<(), String> {
            self.calls.push(format!("clone {image} {name}"));
            Ok(())
        }

        fn start_vm(&mut self, name: &str) -> Result<(), String> {
            self.calls.push(format!("start {name}"));
            Ok(())
        }

        fn get_ip(&mut self, name: &str) -> Result<Option<String>, String> {
            self.calls.push(format!("ip {name}"));
            Ok(if self.ips.is_empty() {
                Some("192.168.64.10".to_owned())
            } else {
                self.ips.remove(0)
            })
        }

        fn ssh_exec(
            &mut self,
            ip: &str,
            _creds: &SshCreds,
            script: &str,
        ) -> Result<VmCommandResult, String> {
            if script == "true" {
                self.ssh_attempts += 1;
                self.calls.push(format!("ssh-ready {ip}"));
                let ready = self.ssh_attempts >= self.ssh_ready_after.max(1);
                return Ok(VmCommandResult {
                    code: if ready { 0 } else { 255 },
                    stdout: String::new(),
                    stderr: String::new(),
                });
            }
            if script.contains("networksetup -setdnsservers") {
                self.calls.push(format!("dns {ip}"));
                return Ok(VmCommandResult {
                    code: 0,
                    stdout: String::new(),
                    stderr: String::new(),
                });
            }
            self.calls.push(format!("job {ip}"));
            Ok(VmCommandResult {
                code: self.job_code,
                stdout: "ok".to_owned(),
                stderr: String::new(),
            })
        }

        fn rsync_to(
            &mut self,
            ip: &str,
            _creds: &SshCreds,
            local_src: &Path,
            remote_dst: &str,
            exclude: &[String],
            delete: bool,
        ) -> Result<(), String> {
            self.calls.push(format!(
                "rsync-to {ip} {} {remote_dst} {:?} {delete}",
                local_src.display(),
                exclude
            ));
            Ok(())
        }

        fn rsync_from(
            &mut self,
            ip: &str,
            _creds: &SshCreds,
            remote_src: &str,
            local_dst: &Path,
        ) -> Result<(), String> {
            self.calls.push(format!(
                "rsync-from {ip} {remote_src} {}",
                local_dst.display()
            ));
            Ok(())
        }

        fn stop_vm(&mut self, name: &str) -> Result<(), String> {
            self.calls.push(format!("stop {name}"));
            Ok(())
        }

        fn delete_vm(&mut self, name: &str) -> Result<(), String> {
            self.calls.push(format!("delete {name}"));
            Ok(())
        }
    }

    fn plan(root: &Path) -> MacosVmJobPlan {
        MacosVmJobPlan {
            vm_name: "agent-ci-macos-1".to_owned(),
            image: "ghcr.io/cirruslabs/macos-sonoma-xcode:latest".to_owned(),
            repo_root: root.join("repo"),
            local_runner_dir: root.join("runner"),
            remote_workspace: "/Users/admin/work".to_owned(),
            remote_runner_dir: "/Users/admin/actions-runner".to_owned(),
            remote_log_dir: "/Users/admin/agent-ci-logs".to_owned(),
            local_log_dir: root.join("logs"),
            creds: SshCreds {
                user: "admin".to_owned(),
                password: "admin".to_owned(),
            },
            dtu_url: "http://127.0.0.1:3000".to_owned(),
            runner_token: "token".to_owned(),
            runner_labels: vec!["macos-14".to_owned(), "arm64".to_owned()],
            job_script: "./run.sh".to_owned(),
        }
    }

    #[test]
    fn host_capability_reports_platform_arch_and_tooling_requirements() {
        assert!(matches!(
            check_macos_vm_host("darwin", "arm64", true, true),
            HostCapability::Supported
        ));
        assert!(matches!(
            check_macos_vm_host("macos", "arm64", true, true),
            HostCapability::Supported
        ));
        assert!(matches!(
            check_macos_vm_host("macos", "aarch64", true, true),
            HostCapability::Supported
        ));
        assert_eq!(
            check_macos_vm_host("linux", "arm64", true, true),
            HostCapability::Unsupported {
                reason: "macOS VM runner requires a macOS host (got linux).".to_owned(),
                hint: None,
            }
        );
        assert_eq!(
            check_macos_vm_host("darwin", "x64", true, true),
            HostCapability::Unsupported {
                reason: "macOS VM runner requires an Apple Silicon host (got x64).".to_owned(),
                hint: Some(
                    "Apple's Virtualization.framework does not support macOS guests on Intel Macs."
                        .to_owned(),
                ),
            }
        );
        assert_eq!(
            check_macos_vm_host("darwin", "arm64", false, true),
            HostCapability::Unsupported {
                reason: "macOS VM runner requires `tart` to be installed.".to_owned(),
                hint: Some("Install with: brew install cirruslabs/cli/tart".to_owned()),
            }
        );
        assert_eq!(
            check_macos_vm_host("darwin", "arm64", true, false),
            HostCapability::Unsupported {
                reason: "macOS VM runner requires `sshpass` to be installed.".to_owned(),
                hint: Some("Install with: brew install hudochenkov/sshpass/sshpass".to_owned()),
            }
        );
    }

    #[test]
    fn image_mapping_matches_github_macos_labels_and_override() {
        let labels = vec!["macos-latest".to_owned()];
        let resolved = resolve_macos_vm_image(&labels, None);
        assert_eq!(
            resolved.image,
            "ghcr.io/cirruslabs/macos-sonoma-xcode:latest"
        );
        assert!(resolved.exact);

        let fallback =
            resolve_macos_vm_image(&["self-hosted".to_owned(), "macOS-custom".to_owned()], None);
        assert_eq!(fallback.image, DEFAULT_MACOS_IMAGE);
        assert!(!fallback.exact);
        assert_eq!(fallback.matched_label, Some("macOS-custom".to_owned()));

        let override_resolution = resolve_macos_vm_image(&labels, Some("custom:image"));
        assert_eq!(override_resolution.image, "custom:image");
    }

    #[test]
    fn tart_and_ssh_argv_builders_match_expected_commands() {
        assert_eq!(
            tart_pull_args("img"),
            CommandSpec::new("tart", ["pull", "img"])
        );
        assert_eq!(
            tart_run_args("vm", false),
            CommandSpec::new("tart", ["run", "--no-graphics", "vm"])
        );
        let creds = SshCreds {
            user: "admin".to_owned(),
            password: "pw".to_owned(),
        };
        let ssh = ssh_args("192.168.64.2", &creds, &["true".to_owned()]);
        assert_eq!(ssh.program, "sshpass");
        assert!(ssh.args.contains(&"StrictHostKeyChecking=no".to_owned()));
        assert!(ssh.args.contains(&"admin@192.168.64.2".to_owned()));
        let rsync = rsync_args("src/", "admin@ip:dst", &creds, &["target".to_owned()], true);
        assert_eq!(rsync.program, "rsync");
        assert!(rsync.args.contains(&"--delete".to_owned()));
        assert!(rsync.args.contains(&"target".to_owned()));
    }

    #[test]
    fn runner_binary_cache_downloads_extracts_and_reuses_marker() {
        let root = temp_dir("runner-cache");
        let mut io = FakeBinaryIo {
            create_run_sh: true,
            calls: vec![],
        };

        let cached = ensure_macos_runner_binary(&mut io, &root, "2.331.0").unwrap();
        assert_eq!(cached.dir, root.join("2.331.0"));
        assert!(cached.dir.join(".extracted").exists());
        assert_eq!(io.calls.len(), 2);

        let cached_again = ensure_macos_runner_binary(&mut io, &root, "2.331.0").unwrap();
        assert_eq!(cached_again, cached);
        assert_eq!(io.calls.len(), 2);
    }

    #[test]
    fn runner_binary_cache_fails_if_tarball_shape_changes() {
        let root = temp_dir("runner-cache-fail");
        let mut io = FakeBinaryIo {
            create_run_sh: false,
            calls: vec![],
        };

        let err = ensure_macos_runner_binary(&mut io, &root, "2.331.0").unwrap_err();

        assert!(err.contains("does not contain run.sh"));
    }

    #[test]
    fn waiters_poll_for_ip_and_ssh_then_dns_override_runs() {
        let mut runtime = FakeVmRuntime {
            ips: vec![None, Some("192.168.64.22".to_owned())],
            ssh_ready_after: 2,
            ..FakeVmRuntime::default()
        };
        let creds = SshCreds {
            user: "admin".to_owned(),
            password: "pw".to_owned(),
        };

        let ip = wait_for_ip(&mut runtime, "vm", 3).unwrap();
        wait_for_ssh(&mut runtime, &ip, &creds, 3).unwrap();
        apply_dns_override(&mut runtime, &ip, &creds, &["1.1.1.1".to_owned()]).unwrap();

        assert_eq!(ip, "192.168.64.22");
        assert_eq!(
            runtime.calls,
            vec![
                "ip vm",
                "ip vm",
                "ssh-ready 192.168.64.22",
                "ssh-ready 192.168.64.22",
                "dns 192.168.64.22"
            ]
        );
    }

    #[test]
    fn vm_job_execution_syncs_repo_runs_script_copies_logs_and_tears_down() {
        let root = temp_dir("job");
        fs::create_dir_all(root.join("repo")).unwrap();
        let plan = plan(&root);
        let mut runtime = FakeVmRuntime {
            ssh_ready_after: 1,
            job_code: 0,
            ..FakeVmRuntime::default()
        };

        let result = execute_macos_vm_job(&mut runtime, &plan).unwrap();

        assert_eq!(result.code, 0);
        assert_eq!(result.ip, "192.168.64.10");
        assert!(
            runtime
                .calls
                .iter()
                .any(|call| call.starts_with("rsync-to 192.168.64.10"))
        );
        assert!(runtime.calls.iter().any(|call| call == "job 192.168.64.10"));
        assert!(runtime.calls.ends_with(&[
            "stop agent-ci-macos-1".to_owned(),
            "delete agent-ci-macos-1".to_owned()
        ]));
    }

    #[test]
    fn runner_script_configures_ephemeral_runner_then_runs_job_script() {
        let root = temp_dir("script");
        let plan = plan(&root);

        let script = build_macos_runner_script(&plan);

        assert!(script.contains("Credentials are pre-written"));
        assert!(!script.contains("./config.sh"));
        assert!(script.contains("./run.sh"));
    }

    #[test]
    fn vm_semaphore_caps_concurrency_fifo() {
        let mut sem = VmSemaphore::new(2).unwrap();
        assert!(sem.try_acquire(1));
        assert!(sem.try_acquire(2));
        assert!(!sem.try_acquire(3));
        sem.release();
        assert!(sem.try_acquire(3));
        assert!(!sem.try_acquire(4));
    }
}
