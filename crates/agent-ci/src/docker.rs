use crate::runner::{
    ContainerExit, ContainerRuntime, JobExecutionPlan, PausedSignal, RetryFromStep, ServiceSpec,
    StartedService, read_paused_signal,
};
use crate::runner_image::ImageOps;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

pub const DEFAULT_SOCKET: &str = "/var/run/docker.sock";
const DOCS_URL: &str =
    "https://github.com/redwoodjs/agent-ci/blob/main/packages/cli/docs/docker-socket.md";
const DEFAULT_DTU_HOST_ALIAS: &str = "host.docker.internal";
const DEFAULT_DOCKER_HOST_GATEWAY: &str = "host-gateway";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DockerSocket {
    pub socket_path: String,
    pub uri: String,
    pub bind_mount_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DockerSocketProbe {
    pub env: BTreeMap<String, String>,
    pub existing_paths: BTreeSet<String>,
    pub accessible_paths: BTreeSet<String>,
    pub realpaths: BTreeMap<String, String>,
    pub docker_context_host: Option<String>,
    pub home: Option<PathBuf>,
}

impl DockerSocketProbe {
    pub fn from_process() -> Self {
        Self {
            env: std::env::vars().collect(),
            existing_paths: BTreeSet::new(),
            accessible_paths: BTreeSet::new(),
            realpaths: BTreeMap::new(),
            docker_context_host: active_docker_context_host(),
            home: std::env::var_os("HOME").map(PathBuf::from),
        }
    }

    fn exists(&self, path: &str) -> bool {
        if self.existing_paths.is_empty() {
            Path::new(path).exists()
        } else {
            self.existing_paths.contains(path)
        }
    }

    fn resolve_if_exists(&self, path: &str) -> Option<String> {
        let resolved = self
            .realpaths
            .get(path)
            .cloned()
            .unwrap_or_else(|| path.to_owned());
        if self.existing_paths.is_empty() {
            let real = fs::canonicalize(path).ok()?;
            fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&real)
                .ok()?;
            return Some(real.to_string_lossy().into_owned());
        }
        (self.exists(path) && self.accessible_paths.contains(&resolved)).then_some(resolved)
    }

    fn docker_desktop_running_without_default_socket(&self) -> bool {
        let Some(home) = &self.home else {
            return false;
        };
        self.exists(&home.join(".docker/run/docker.sock").to_string_lossy())
    }
}

pub fn resolve_docker_socket(probe: &DockerSocketProbe) -> Result<DockerSocket, String> {
    if let Some(env_host) = probe
        .env
        .get("AGENT_CI_DOCKER_HOST")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        if !env_host.starts_with("unix://") {
            return Ok(DockerSocket {
                socket_path: String::new(),
                uri: env_host.to_owned(),
                bind_mount_path: String::new(),
            });
        }
        let socket_path = env_host.trim_start_matches("unix://");
        if let Some(resolved) = probe.resolve_if_exists(socket_path) {
            return Ok(DockerSocket {
                socket_path: resolved.clone(),
                uri: format!("unix://{resolved}"),
                bind_mount_path: socket_path.to_owned(),
            });
        }
        return Err(unusable_socket_error(
            probe,
            &format!("AGENT_CI_DOCKER_HOST={env_host} does not resolve to a working socket."),
        ));
    }

    if !probe.exists(DEFAULT_SOCKET) {
        return Err(unusable_socket_error(
            probe,
            &format!("{DEFAULT_SOCKET} is missing or a dangling symlink."),
        ));
    }

    if let Some(resolved) = probe.resolve_if_exists(DEFAULT_SOCKET) {
        return Ok(DockerSocket {
            socket_path: resolved.clone(),
            uri: format!("unix://{resolved}"),
            bind_mount_path: DEFAULT_SOCKET.to_owned(),
        });
    }

    if let Some(context_host) = &probe.docker_context_host {
        if let Some(socket_path) = context_host.strip_prefix("unix://") {
            if probe.exists(socket_path) {
                return Ok(DockerSocket {
                    socket_path: socket_path.to_owned(),
                    uri: format!("unix://{socket_path}"),
                    bind_mount_path: DEFAULT_SOCKET.to_owned(),
                });
            }
        }
    }

    Err(unusable_socket_error(
        probe,
        &format!(
            "{DEFAULT_SOCKET} exists but is not readable, and no active docker context provides an alternative."
        ),
    ))
}

fn active_docker_context_host() -> Option<String> {
    let output = Command::new("docker")
        .args([
            "context",
            "inspect",
            "--format",
            "{{.Endpoints.docker.Host}}",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!value.is_empty() && value != "<no value>").then_some(value)
}

fn unusable_socket_error(probe: &DockerSocketProbe, detail: &str) -> String {
    let mut lines = vec![
        "agent-ci couldn't use a Docker socket at /var/run/docker.sock.".to_owned(),
        detail.to_owned(),
        String::new(),
        "A working Docker socket is required there (or set AGENT_CI_DOCKER_HOST explicitly)."
            .to_owned(),
    ];
    if probe.docker_desktop_running_without_default_socket() {
        lines.extend([
            String::new(),
            "Docker Desktop is running but the default socket is disabled.".to_owned(),
            "Enable it: Docker Desktop → Settings → Advanced →".to_owned(),
            "  \"Allow the default Docker socket to be used (requires password)\" → Apply & Restart.".to_owned(),
        ]);
    }
    lines.extend([String::new(), format!("See: {DOCS_URL}")]);
    lines.join("\n")
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ParsedContainerOptions {
    pub env: Vec<String>,
    pub labels: BTreeMap<String, String>,
}

pub fn parse_container_options(options: Option<&str>) -> ParsedContainerOptions {
    let mut parsed = ParsedContainerOptions::default();
    let Some(options) = options else {
        return parsed;
    };
    let tokens = options.split_whitespace().collect::<Vec<_>>();
    let mut index = 0;
    while index < tokens.len() {
        match tokens[index] {
            "--env" | "-e" if index + 1 < tokens.len() => {
                index += 1;
                parsed.env.push(tokens[index].to_owned());
            }
            "--label" | "-l" if index + 1 < tokens.len() => {
                index += 1;
                let token = tokens[index];
                let (key, value) = token.split_once('=').unwrap_or((token, ""));
                parsed.labels.insert(key.to_owned(), value.to_owned());
            }
            _ => {}
        }
        index += 1;
    }
    parsed
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerEnvOpts {
    pub container_name: String,
    pub registration_token: String,
    pub repo_url: String,
    pub docker_api_url: String,
    pub github_repo: String,
    pub head_sha: Option<String>,
    pub dtu_host: String,
    pub use_direct_container: bool,
}

pub fn build_container_env(opts: &ContainerEnvOpts) -> Vec<String> {
    let mut env = vec![
        format!("RUNNER_NAME={}", opts.container_name),
        format!("RUNNER_TOKEN={}", opts.registration_token),
        format!("RUNNER_REPOSITORY_URL={}", opts.repo_url),
        format!("GITHUB_API_URL={}", opts.docker_api_url),
        format!("GITHUB_SERVER_URL={}", opts.repo_url),
        format!("GITHUB_REPOSITORY={}", opts.github_repo),
        "AGENT_CI_LOCAL=true".to_owned(),
        "AGENT_CI_LOCAL_SYNC=true".to_owned(),
        format!("AGENT_CI_HEAD_SHA={}", opts.head_sha.as_deref().unwrap_or("HEAD")),
        format!("AGENT_CI_DTU_HOST={}", opts.dtu_host),
        format!("ACTIONS_CACHE_URL={}/", opts.docker_api_url),
        format!("ACTIONS_RESULTS_URL={}/", opts.docker_api_url),
        "ACTIONS_RUNTIME_TOKEN=mock_cache_token_123".to_owned(),
        "RUNNER_TOOL_CACHE=/opt/hostedtoolcache".to_owned(),
        "PATH=/home/runner/externals/node24/bin:/home/runner/externals/node20/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin".to_owned(),
        "FORCE_COLOR=1".to_owned(),
    ];
    if opts.use_direct_container {
        env.push("RUNNER_ALLOW_RUNASROOT=1".to_owned());
        env.push("DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1".to_owned());
    }
    env
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerBindsOpts {
    pub host_work_dir: String,
    pub shims_dir: String,
    pub signals_dir: Option<String>,
    pub diag_dir: String,
    pub tool_cache_dir: String,
    pub pnpm_store_dir: Option<String>,
    pub npm_cache_dir: Option<String>,
    pub yarn_cache_dir: Option<String>,
    pub bun_cache_dir: Option<String>,
    pub playwright_cache_dir: String,
    pub cypress_cache_dir: Option<String>,
    pub warm_modules_dir: String,
    pub host_runner_dir: String,
    pub use_direct_container: bool,
    pub github_repo: String,
    pub docker_socket_path: Option<String>,
}

pub fn build_container_binds(opts: &ContainerBindsOpts) -> Vec<String> {
    let repo_name = opts.github_repo.split('/').next_back().unwrap_or("repo");
    let docker_socket_path = opts.docker_socket_path.as_deref().unwrap_or(DEFAULT_SOCKET);
    let mut binds = Vec::new();
    if opts.use_direct_container {
        binds.push(format!("{}:/home/runner", opts.host_runner_dir));
    }
    binds.extend([
        format!("{}:/home/runner/_work", opts.host_work_dir),
        format!("{docker_socket_path}:/var/run/docker.sock"),
        format!("{}:/tmp/agent-ci-shims", opts.shims_dir),
    ]);
    if let Some(signals_dir) = &opts.signals_dir {
        binds.push(format!("{signals_dir}:/tmp/agent-ci-signals"));
    }
    binds.extend([
        format!("{}:/home/runner/_diag", opts.diag_dir),
        format!("{}:/opt/hostedtoolcache", opts.tool_cache_dir),
    ]);
    if let Some(dir) = &opts.pnpm_store_dir {
        binds.push(format!("{dir}:/home/runner/_work/.pnpm-store"));
    }
    if let Some(dir) = &opts.npm_cache_dir {
        binds.push(format!("{dir}:/home/runner/.npm"));
    }
    if let Some(dir) = &opts.yarn_cache_dir {
        binds.push(format!("{dir}:/home/runner/.cache/yarn"));
    }
    if let Some(dir) = &opts.bun_cache_dir {
        binds.push(format!("{dir}:/home/runner/.bun"));
    }
    binds.push(format!(
        "{}:/home/runner/.cache/ms-playwright",
        opts.playwright_cache_dir
    ));
    if let Some(dir) = &opts.cypress_cache_dir {
        binds.push(format!("{dir}:/home/runner/.cache/Cypress"));
    }
    binds.push(format!(
        "{}:/home/runner/_work/{repo_name}/{repo_name}/node_modules",
        opts.warm_modules_dir
    ));
    binds
}

pub fn cache_permission_fix_commands() -> Vec<String> {
    vec![
        // Playwright and Cypress live under /home/runner/.cache. Bind mounts can
        // create that parent as root inside Docker Desktop/Colima, so make the
        // parent writable before package installers try to populate it.
        "MAYBE_SUDO chmod 1777 /home/runner/.cache 2>/dev/null || true".to_owned(),
        "MAYBE_SUDO chmod 1777 /home/runner/_work 2>/dev/null || true".to_owned(),
    ]
}

pub fn docker_socket_permission_fix_command() -> String {
    // Native Linux Docker commonly exposes /var/run/docker.sock as root:docker
    // 0660. The runner user is not in the host docker group, so buildx/docker
    // steps need the same pre-step chmod used by the TypeScript runner path.
    "MAYBE_SUDO chmod 666 /var/run/docker.sock 2>/dev/null || true".to_owned()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerCmdOpts {
    pub dtu_port: String,
    pub dtu_host: String,
    pub use_direct_container: bool,
    pub container_name: String,
}

pub fn build_container_cmd(opts: &ContainerCmdOpts) -> Vec<String> {
    let dtu_base_url = format!("http://{}:{}", opts.dtu_host, opts.dtu_port);
    let credential_snippet = if opts.use_direct_container {
        String::new()
    } else {
        format!(
            "echo '{{\"agentId\":1,\"agentName\":\"{}\",\"poolId\":1,\"poolName\":\"Default\",\"serverUrl\":\"{}\",\"gitHubUrl\":\"{}/'$GITHUB_REPOSITORY'\",\"workFolder\":\"_work\",\"ephemeral\":true}}' > /home/runner/.runner && echo '{{\"scheme\":\"OAuth\",\"data\":{{\"clientId\":\"00000000-0000-0000-0000-000000000000\",\"authorizationUrl\":\"{}/_apis/oauth2/token\",\"oAuthEndpointUrl\":\"{}/_apis/oauth2/token\",\"requireFipsCryptography\":\"False\"}}}}' > /home/runner/.credentials && echo '{{\"d\":\"CQpCI+sO2GD1N/JsHHI9zEhMlu5Fcc8mU4O2bO6iscOsagFjvEnTesJgydC/Go1HuOBlx+GT9EG2h7+juS0z2o5n8Mvt5BBxlK+tqoDOs8VfQ9CSUl3hqYRPeNdBfnA1w8ovLW0wqfPO08FWTLI0urYsnwjZ5BQrBM+D7zYeA0aCsKdo75bKmaEKnmqrtIEhb7hE45XQa32Yt0RPCPi8QcQAY2HLHbdWdZYDj6k/UuDvz9H/xlDzwYq6Yikk2RSMArFzaufxCGS9tBZNEACDPYgnZnEMXRcvsnZ9FYbq81KOSifCmq7Yocq+j3rY5zJCD+PIDY9QJwPxB4PGasRKAQ==\",\"dp\":\"A0sY1oOz1+3uUMiy+I5xGuHGHOrEQPYspd1xGClBYYsa/Za0UDWS7V0Tn1cbRWfWtNe5vTpxcvwQd6UZBwrtHF6R2zyXFhE++PLPhCe0tH4C5FY9i9jUw9Vo8t44i/s5JUHU2B1mEptXFUA0GcVrLKS8toZSgqELSS2Q/YLRxoE=\",\"dq\":\"GrLC9dPJ5n3VYw51ghCH7tybUN9/Oe4T8d9v4dLQ34RQEWHwRd4g3U3zkvuhpXFPloUTMmkxS7MF5pS1evrtzkay4QUTDv+28s0xRuAsw5qNTzuFygg8t93MvpvTVZ2TNApW6C7NFvkL9NbxAnU8+I61/3ow7i6a7oYJJ0hWAxE=\",\"exponent\":\"AQAB\",\"inverseQ\":\"8DVz9FSvEdt5W4B9OjgakZHwGfnhn2VLDUxrsR5ilC5tPC/IgA8C2xEfKQM1t+K/N3pAYHBYQ6EPgtW4kquBS/Sy102xbRI7GSCnUbRtTpWYPOaCn6EaxBNzwWzbp5vCbCGvFqlSu4+OBYRVe+iCj+gAnkmT/TKPhHHbTjJHvw==\",\"modulus\":\"x0eoW2DD7xsW5YiorMN8pNHVvZk4ED1SHlA/bmVnRz5FjEDnQloMn0nBgIUHxoNArksknrp/FOVJv5sJHJTiRZkOp+ZmH7d3W3gmw63IxK2C5pV+6xfav9jR2+Wt/6FMYMgG2utBdF95oif1f2XREFovHoXkWms2l0CPLLHVPO44Hh9EEmBmjOeMJEZkulHJ44z9y8e+GZ2nYqO0ZiRWQcRObZ0vlRaGg6PPOl4ltay0BfNksMB3NDtlhkdVkAEFQxEaZZDK9NtkvNljXCioP3TyTAbqNUGsYCA5D+IHGZT9An99J9vUqTFP6TKjqUvy9WNiIzaUksCySA0a4SVBkQ==\",\"p\":\"8fgAdmWy+sTzAN19fYkWMQqeC7t1BCQMo5z5knfVLg8TtwP9ZGqDtoe+r0bGv3UgVsvvDdP/QwRvRVP+5G9l999Y6b4VbSdUbrfPfOgjpPDmRTQzHDve5jh5xBENQoRXYm7PMgHGmjwuFsE/tKtSGTrvt2Z3qcYAo0IOqLLhYmE=\",\"q\":\"0tXx4+P7gUWePf92UJLkzhNBClvdnmDbIt52Lui7YCARczbN/asCDJxcMy6Bh3qmIx/bNuOUrfzHkYZHfnRw8AGEK80qmiLLPI6jrUBOGRajmzemGQx0W8FWalEQfGdNIv9R2nsegDRoMq255Zo/qX60xQ6abpp0c6UNhVYSjTE=\"}}' > /home/runner/.credentials_rsaparams && ",
            opts.container_name, dtu_base_url, dtu_base_url, dtu_base_url, dtu_base_url
        )
    };

    let script = [
        "MAYBE_SUDO() { if command -v sudo >/dev/null 2>&1; then sudo -n \"$@\"; else \"$@\"; fi; }".to_owned(),
        "BOOT_T0=$(date +%s%3N); T0=$BOOT_T0".to_owned(),
        "if [ -f /usr/bin/git ]; then MAYBE_SUDO mv /usr/bin/git /usr/bin/git.real 2>/dev/null || true; MAYBE_SUDO cp -p /tmp/agent-ci-shims/git /usr/bin/git 2>/dev/null; MAYBE_SUDO chmod +x /usr/bin/git 2>/dev/null; fi".to_owned(),
        "T1=$(date +%s%3N); echo \"[agent-ci:boot] git-shim: $((T1-T0))ms\"; T0=$T1".to_owned(),
        docker_socket_permission_fix_command(),
        "T1=$(date +%s%3N); echo \"[agent-ci:boot] docker-sock: $((T1-T0))ms\"; T0=$T1".to_owned(),
    ]
    .into_iter()
    .chain(cache_permission_fix_commands())
    .chain([
        "MAYBE_SUDO chmod 1777 /home/runner/_diag 2>/dev/null || true".to_owned(),
        "cd /home/runner".to_owned(),
        format!("{credential_snippet}true"),
        "T1=$(date +%s%3N); echo \"[agent-ci:boot] credentials: $((T1-T0))ms\"; T0=$T1".to_owned(),
        "REPO_NAME=$(basename $GITHUB_REPOSITORY)".to_owned(),
        "WORKSPACE_PATH=/home/runner/_work/$REPO_NAME/$REPO_NAME".to_owned(),
        "mkdir -p $WORKSPACE_PATH /home/runner/_work/_actions /home/runner/_work/_temp /home/runner/_work/_tool".to_owned(),
        "T1=$(date +%s%3N); echo \"[agent-ci:boot] workspace-setup: $((T1-T0))ms\"; T0=$T1".to_owned(),
        "echo \"[agent-ci:boot] total: $(($(date +%s%3N)-BOOT_T0))ms\"".to_owned(),
        "echo \"[agent-ci:boot] starting run.sh --once\"".to_owned(),
        "./run.sh --once".to_owned(),
    ])
    .collect::<Vec<_>>()
    .join(" && ");

    if opts.use_direct_container {
        vec!["-c".to_owned(), script]
    } else {
        vec!["bash".to_owned(), "-c".to_owned(), script]
    }
}

pub fn resolve_docker_api_url(dtu_url: &str, dtu_host: &str) -> String {
    let Some((scheme, rest)) = dtu_url.split_once("://") else {
        return dtu_url.to_owned();
    };
    let (authority, suffix) = rest.split_once('/').unwrap_or((rest, ""));
    let (host, port) = authority.split_once(':').unwrap_or((authority, ""));
    let new_host = if matches!(host, "localhost" | "127.0.0.1" | "::1") {
        dtu_host
    } else {
        host
    };
    let authority = if port.is_empty() {
        new_host.to_owned()
    } else {
        format!("{new_host}:{port}")
    };
    if suffix.is_empty() {
        format!("{scheme}://{authority}")
    } else {
        format!("{scheme}://{authority}/{suffix}")
    }
}

pub fn resolve_docker_extra_hosts(
    env: &BTreeMap<String, String>,
    dtu_host: &str,
) -> Option<Vec<String>> {
    if let Some(configured) = env.get("AGENT_CI_DOCKER_EXTRA_HOSTS") {
        let parsed = configured
            .split(',')
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        return (!parsed.is_empty()).then_some(parsed);
    }
    if env
        .get("AGENT_CI_DOCKER_DISABLE_DEFAULT_EXTRA_HOSTS")
        .is_some_and(|value| value == "1")
    {
        return None;
    }
    if dtu_host != DEFAULT_DTU_HOST_ALIAS {
        return None;
    }
    let gateway = env
        .get("AGENT_CI_DOCKER_HOST_GATEWAY")
        .map(String::as_str)
        .unwrap_or(DEFAULT_DOCKER_HOST_GATEWAY);
    Some(vec![format!("{DEFAULT_DTU_HOST_ALIAS}:{gateway}")])
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DockerRunConfig {
    pub name: String,
    pub image: String,
    pub network: String,
    pub env: Vec<String>,
    pub binds: Vec<String>,
    pub extra_hosts: Vec<String>,
    pub ports: BTreeMap<String, String>,
    pub options: Option<String>,
    pub health_cmd: Option<String>,
    pub detach: bool,
    pub command: Vec<String>,
}

fn split_shell_words(input: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        match (quote, ch) {
            (Some(q), c) if c == q => quote = None,
            (None, '\'' | '"') => quote = Some(ch),
            (None, c) if c.is_whitespace() => {
                if !current.is_empty() {
                    words.push(std::mem::take(&mut current));
                }
            }
            (_, '\\') => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            (_, c) => current.push(c),
        }
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

pub fn docker_run_args(config: &DockerRunConfig) -> Vec<String> {
    let mut args = vec!["run".to_owned()];
    if config.detach {
        args.push("-d".to_owned());
    }
    args.extend([
        "--name".to_owned(),
        config.name.clone(),
        "--network".to_owned(),
        config.network.clone(),
    ]);
    for env in &config.env {
        args.extend(["-e".to_owned(), env.clone()]);
    }
    for bind in &config.binds {
        args.extend(["-v".to_owned(), bind.clone()]);
    }
    for host in &config.extra_hosts {
        args.extend(["--add-host".to_owned(), host.clone()]);
    }
    for (container_port, host_port) in &config.ports {
        args.extend(["-p".to_owned(), format!("{host_port}:{container_port}")]);
    }
    if let Some(health_cmd) = &config.health_cmd {
        args.extend(["--health-cmd".to_owned(), health_cmd.clone()]);
    }
    if let Some(options) = &config.options {
        args.extend(split_shell_words(options));
    }
    args.push(config.image.clone());
    args.extend(config.command.iter().cloned());
    args
}

pub fn docker_network_create_args(name: &str) -> Vec<String> {
    vec!["network".to_owned(), "create".to_owned(), name.to_owned()]
}

pub fn docker_network_remove_args(name: &str) -> Vec<String> {
    vec!["network".to_owned(), "rm".to_owned(), name.to_owned()]
}

pub fn docker_rm_force_args(name: &str) -> Vec<String> {
    vec!["rm".to_owned(), "-f".to_owned(), name.to_owned()]
}

#[derive(Debug, Clone)]
pub struct DockerCliRuntime {
    docker_bin: String,
}

impl Default for DockerCliRuntime {
    fn default() -> Self {
        Self::new("docker")
    }
}

impl DockerCliRuntime {
    pub fn new(docker_bin: impl Into<String>) -> Self {
        Self {
            docker_bin: docker_bin.into(),
        }
    }

    pub fn create_network(&mut self, name: &str) -> Result<(), String> {
        self.docker_output(&docker_network_create_args(name))
            .map(|_| ())
    }

    pub fn remove_network(&mut self, name: &str) -> Result<(), String> {
        self.docker_output(&docker_network_remove_args(name))
            .map(|_| ())
    }

    fn docker_output(&mut self, args: &[String]) -> Result<String, String> {
        let output = Command::new(&self.docker_bin)
            .args(args)
            .output()
            .map_err(|err| format!("failed to run docker: {err}"))?;
        if !output.status.success() {
            return Err(format!(
                "docker {} failed: {}",
                args.join(" "),
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
    }
}

impl ImageOps for DockerCliRuntime {
    fn image_exists(&mut self, image: &str) -> Result<bool, String> {
        let output = Command::new(&self.docker_bin)
            .args(["image", "inspect", image])
            .output()
            .map_err(|err| format!("failed to run docker: {err}"))?;
        Ok(output.status.success())
    }

    fn pull_image(&mut self, image: &str) -> Result<(), String> {
        self.docker_output(&["pull".to_owned(), image.to_owned()])
            .map(|_| ())
    }

    fn build_image(
        &mut self,
        image: &str,
        dockerfile: &Path,
        context: Option<&Path>,
    ) -> Result<(), String> {
        if let Some(context) = context {
            return self
                .docker_output(&[
                    "build".to_owned(),
                    "-t".to_owned(),
                    image.to_owned(),
                    "-f".to_owned(),
                    dockerfile.to_string_lossy().into_owned(),
                    context.to_string_lossy().into_owned(),
                ])
                .map(|_| ());
        }

        let dockerfile_content = fs::read(dockerfile).map_err(|err| err.to_string())?;
        let mut child = Command::new(&self.docker_bin)
            .args(["build", "-t", image, "-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|err| format!("failed to run docker build: {err}"))?;
        child
            .stdin
            .take()
            .ok_or_else(|| "failed to open docker build stdin".to_owned())?
            .write_all(&dockerfile_content)
            .map_err(|err| err.to_string())?;
        let output = child.wait_with_output().map_err(|err| err.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            ))
        }
    }
}

fn ignore_container_removal_in_progress(result: Result<String, String>) -> Result<(), String> {
    match result {
        Ok(_) => Ok(()),
        Err(err)
            if err.contains("removal of container") && err.contains("is already in progress") =>
        {
            Ok(())
        }
        Err(err) => Err(err),
    }
}

fn spawn_log_reader<R>(reader: R, tx: mpsc::Sender<String>)
where
    R: std::io::Read + Send + 'static,
{
    thread::spawn(move || {
        let reader = BufReader::new(reader);
        for line in reader.lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
}

impl ContainerRuntime for DockerCliRuntime {
    fn create_network(&mut self, network: &str) -> Result<(), String> {
        if let Ok(containers) = self.docker_output(&[
            "ps".to_owned(),
            "-aq".to_owned(),
            "--filter".to_owned(),
            format!("name=^/{network}"),
        ]) {
            for container in containers
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
            {
                let _ = self.docker_output(&docker_rm_force_args(container));
            }
        }
        let _ = self.docker_output(&docker_network_remove_args(network));
        self.docker_output(&docker_network_create_args(network))
            .map(|_| ())
    }

    fn remove_network(&mut self, network: &str) -> Result<(), String> {
        self.docker_output(&docker_network_remove_args(network))
            .map(|_| ())
    }

    fn start_service(
        &mut self,
        service: &ServiceSpec,
        network: &str,
    ) -> Result<StartedService, String> {
        let container_name = format!("{network}-svc-{}", service.id);
        let config = DockerRunConfig {
            name: container_name.clone(),
            image: service.image.clone(),
            network: network.to_owned(),
            env: service.env.clone(),
            binds: Vec::new(),
            extra_hosts: Vec::new(),
            ports: service.ports.clone(),
            options: Some(match &service.options {
                Some(options) if !options.trim().is_empty() => {
                    format!("--network-alias {} {options}", service.id)
                }
                _ => format!("--network-alias {}", service.id),
            }),
            health_cmd: service.health_cmd.clone(),
            detach: true,
            command: Vec::new(),
        };
        self.docker_output(&docker_run_args(&config))?;
        Ok(StartedService {
            id: service.id.clone(),
            container_name,
        })
    }

    fn wait_service_healthy(&mut self, service: &StartedService) -> Result<(), String> {
        let mut last_status = String::new();
        for _ in 0..60 {
            let status = self.docker_output(&[
                "inspect".to_owned(),
                "-f".to_owned(),
                "{{if .State.Health}}{{.State.Health.Status}}{{else}}healthy{{end}}".to_owned(),
                service.container_name.clone(),
            ])?;
            if status == "healthy" {
                return Ok(());
            }
            last_status = status;
            thread::sleep(Duration::from_secs(1));
        }
        Err(format!(
            "service '{}' is not healthy yet: {last_status}",
            service.id
        ))
    }

    fn remove_service(&mut self, service: &StartedService) -> Result<(), String> {
        ignore_container_removal_in_progress(
            self.docker_output(&docker_rm_force_args(&service.container_name)),
        )
    }

    fn start_runner(&mut self, plan: &JobExecutionPlan, network: &str) -> Result<(), String> {
        let _ = self.docker_output(&docker_rm_force_args(&plan.container_name));
        let config = DockerRunConfig {
            name: plan.container_name.clone(),
            image: plan.image.clone(),
            network: network.to_owned(),
            env: plan.env.clone(),
            binds: plan.binds.clone(),
            extra_hosts: plan.extra_hosts.clone(),
            ports: BTreeMap::new(),
            options: None,
            health_cmd: None,
            detach: true,
            command: plan.command.clone(),
        };
        self.docker_output(&docker_run_args(&config)).map(|_| ())
    }

    fn stream_runner_logs(
        &mut self,
        runner_name: &str,
        signals_dir: Option<&Path>,
        sink: &mut dyn Write,
        on_pause: &mut dyn FnMut(PausedSignal),
    ) -> Result<(), String> {
        let mut child = Command::new(&self.docker_bin)
            .args(["logs", "-f", runner_name])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|err| format!("failed to stream docker logs: {err}"))?;
        let (tx, rx) = mpsc::channel::<String>();
        if let Some(stdout) = child.stdout.take() {
            spawn_log_reader(stdout, tx.clone());
        }
        if let Some(stderr) = child.stderr.take() {
            spawn_log_reader(stderr, tx.clone());
        }
        drop(tx);

        let mut last_paused_content = String::new();
        loop {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(line) => {
                    writeln!(sink, "{line}").map_err(|err| err.to_string())?;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }

            if let Some(signals_dir) = signals_dir {
                let paused_path = signals_dir.join("paused");
                if let Ok(content) = fs::read_to_string(&paused_path)
                    && content != last_paused_content
                {
                    last_paused_content = content;
                    if let Some(signal) = read_paused_signal(signals_dir) {
                        on_pause(signal);
                    }
                }
            }
        }

        let status = child.wait().map_err(|err| err.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("docker logs failed for {runner_name}"))
        }
    }

    fn wait_runner(&mut self, runner_name: &str) -> Result<ContainerExit, String> {
        let code = self.docker_output(&["wait".to_owned(), runner_name.to_owned()])?;
        Ok(ContainerExit {
            code: code.trim().parse::<i32>().unwrap_or(1),
        })
    }

    fn remove_runner(&mut self, runner_name: &str) -> Result<(), String> {
        ignore_container_removal_in_progress(self.docker_output(&docker_rm_force_args(runner_name)))
    }

    fn resume_runner(
        &mut self,
        runner_name: &str,
        _from_step: Option<RetryFromStep>,
    ) -> Result<ContainerExit, String> {
        let _ = self.docker_output(&["unpause".to_owned(), runner_name.to_owned()]);
        self.wait_runner(runner_name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe() -> DockerSocketProbe {
        DockerSocketProbe {
            env: BTreeMap::new(),
            existing_paths: BTreeSet::new(),
            accessible_paths: BTreeSet::new(),
            realpaths: BTreeMap::new(),
            docker_context_host: None,
            home: Some(PathBuf::from("/home/me")),
        }
    }

    #[test]
    fn explicit_non_unix_docker_host_wins() {
        let mut probe = probe();
        probe.env.insert(
            "AGENT_CI_DOCKER_HOST".to_owned(),
            "ssh://docker-host".to_owned(),
        );

        let socket = resolve_docker_socket(&probe).unwrap();

        assert_eq!(socket.uri, "ssh://docker-host");
        assert_eq!(socket.bind_mount_path, "");
    }

    #[test]
    fn explicit_unix_socket_resolves_real_path_and_keeps_bind_path() {
        let mut probe = probe();
        probe.env.insert(
            "AGENT_CI_DOCKER_HOST".to_owned(),
            "unix:///tmp/docker.sock".to_owned(),
        );
        probe.existing_paths.insert("/tmp/docker.sock".to_owned());
        probe.realpaths.insert(
            "/tmp/docker.sock".to_owned(),
            "/private/tmp/docker.sock".to_owned(),
        );
        probe
            .accessible_paths
            .insert("/private/tmp/docker.sock".to_owned());

        let socket = resolve_docker_socket(&probe).unwrap();

        assert_eq!(socket.socket_path, "/private/tmp/docker.sock");
        assert_eq!(socket.uri, "unix:///private/tmp/docker.sock");
        assert_eq!(socket.bind_mount_path, "/tmp/docker.sock");
    }

    #[test]
    fn default_socket_uses_var_run_as_bind_mount() {
        let mut probe = probe();
        probe.existing_paths.insert(DEFAULT_SOCKET.to_owned());
        probe
            .realpaths
            .insert(DEFAULT_SOCKET.to_owned(), "/real/docker.sock".to_owned());
        probe
            .accessible_paths
            .insert("/real/docker.sock".to_owned());

        let socket = resolve_docker_socket(&probe).unwrap();

        assert_eq!(socket.socket_path, "/real/docker.sock");
        assert_eq!(socket.bind_mount_path, DEFAULT_SOCKET);
    }

    #[test]
    fn falls_back_to_docker_context_when_default_socket_is_not_accessible() {
        let mut probe = probe();
        probe.existing_paths.insert(DEFAULT_SOCKET.to_owned());
        probe
            .existing_paths
            .insert("/home/me/.docker/desktop/docker.sock".to_owned());
        probe.docker_context_host = Some("unix:///home/me/.docker/desktop/docker.sock".to_owned());

        let socket = resolve_docker_socket(&probe).unwrap();

        assert_eq!(socket.socket_path, "/home/me/.docker/desktop/docker.sock");
        assert_eq!(socket.bind_mount_path, DEFAULT_SOCKET);
    }

    #[test]
    fn missing_default_socket_reports_docker_desktop_hint() {
        let mut probe = probe();
        probe
            .existing_paths
            .insert("/home/me/.docker/run/docker.sock".to_owned());

        let err = resolve_docker_socket(&probe).unwrap_err();

        assert!(err.contains("Docker Desktop is running but the default socket is disabled"));
        assert!(err.contains(DOCS_URL));
    }

    #[test]
    fn parses_container_options_env_and_labels() {
        let parsed = parse_container_options(Some("--env FOO=bar -e BAZ=qux --label a=b -l empty"));

        assert_eq!(parsed.env, vec!["FOO=bar", "BAZ=qux"]);
        assert_eq!(parsed.labels.get("a"), Some(&"b".to_owned()));
        assert_eq!(parsed.labels.get("empty"), Some(&String::new()));
    }

    #[test]
    fn builds_container_environment() {
        let env = build_container_env(&ContainerEnvOpts {
            container_name: "runner".to_owned(),
            registration_token: "token".to_owned(),
            repo_url: "http://github.local/owner/repo".to_owned(),
            docker_api_url: "http://host.docker.internal:1234".to_owned(),
            github_repo: "owner/repo".to_owned(),
            head_sha: Some("abc".to_owned()),
            dtu_host: "host.docker.internal".to_owned(),
            use_direct_container: true,
        });

        assert!(env.contains(&"RUNNER_NAME=runner".to_owned()));
        assert!(env.contains(&"AGENT_CI_HEAD_SHA=abc".to_owned()));
        assert!(env.contains(&"RUNNER_ALLOW_RUNASROOT=1".to_owned()));
    }

    #[test]
    fn builds_container_binds_with_optional_caches() {
        let binds = build_container_binds(&ContainerBindsOpts {
            host_work_dir: "/work".to_owned(),
            shims_dir: "/shims".to_owned(),
            signals_dir: Some("/signals".to_owned()),
            diag_dir: "/diag".to_owned(),
            tool_cache_dir: "/tools".to_owned(),
            pnpm_store_dir: Some("/pnpm".to_owned()),
            npm_cache_dir: None,
            yarn_cache_dir: Some("/yarn".to_owned()),
            bun_cache_dir: Some("/bun".to_owned()),
            playwright_cache_dir: "/pw".to_owned(),
            cypress_cache_dir: Some("/cypress".to_owned()),
            warm_modules_dir: "/warm".to_owned(),
            host_runner_dir: "/runner".to_owned(),
            use_direct_container: true,
            github_repo: "owner/repo".to_owned(),
            docker_socket_path: Some("/docker.sock".to_owned()),
        });

        assert!(binds.contains(&"/runner:/home/runner".to_owned()));
        assert!(binds.contains(&"/docker.sock:/var/run/docker.sock".to_owned()));
        assert!(binds.contains(&"/signals:/tmp/agent-ci-signals".to_owned()));
        assert!(binds.contains(&"/yarn:/home/runner/.cache/yarn".to_owned()));
        assert!(binds.contains(&"/cypress:/home/runner/.cache/Cypress".to_owned()));
        assert!(binds.contains(&"/warm:/home/runner/_work/repo/repo/node_modules".to_owned()));
    }

    #[test]
    fn cache_permission_fixes_cover_browser_cache_parent() {
        let commands = cache_permission_fix_commands();

        assert!(
            commands
                .iter()
                .any(|command| command.contains("/home/runner/.cache"))
        );
        assert!(
            commands
                .iter()
                .any(|command| command.contains("/home/runner/_work"))
        );
    }

    #[test]
    fn docker_socket_permission_fix_matches_buildx_needs() {
        let command = docker_socket_permission_fix_command();

        assert!(command.contains("chmod 666 /var/run/docker.sock"));
    }

    #[test]
    fn builds_docker_run_args_for_runner_container() {
        let args = docker_run_args(&DockerRunConfig {
            name: "agent-ci-1-j1".to_owned(),
            image: "ghcr.io/redwoodjs/agent-ci-runner:latest".to_owned(),
            network: "agent-ci-agent-ci-1-j1".to_owned(),
            env: vec!["RUNNER_NAME=agent-ci-1-j1".to_owned()],
            binds: vec!["/work:/home/runner/_work".to_owned()],
            extra_hosts: vec!["host.docker.internal:host-gateway".to_owned()],
            ports: BTreeMap::new(),
            options: None,
            health_cmd: None,
            detach: true,
            command: vec!["bash".to_owned(), "-c".to_owned(), "echo ok".to_owned()],
        });

        assert_eq!(
            args,
            vec![
                "run",
                "-d",
                "--name",
                "agent-ci-1-j1",
                "--network",
                "agent-ci-agent-ci-1-j1",
                "-e",
                "RUNNER_NAME=agent-ci-1-j1",
                "-v",
                "/work:/home/runner/_work",
                "--add-host",
                "host.docker.internal:host-gateway",
                "ghcr.io/redwoodjs/agent-ci-runner:latest",
                "bash",
                "-c",
                "echo ok",
            ]
        );
    }

    #[test]
    fn builds_docker_run_args_for_service_container() {
        let mut ports = BTreeMap::new();
        ports.insert("5432".to_owned(), "15432".to_owned());
        let args = docker_run_args(&DockerRunConfig {
            name: "postgres".to_owned(),
            image: "postgres:16".to_owned(),
            network: "agent-ci-net".to_owned(),
            env: vec!["POSTGRES_PASSWORD=postgres".to_owned()],
            binds: Vec::new(),
            extra_hosts: Vec::new(),
            ports,
            options: Some("--label agent-ci=true".to_owned()),
            health_cmd: Some("pg_isready".to_owned()),
            detach: true,
            command: Vec::new(),
        });

        assert_eq!(
            args,
            vec![
                "run",
                "-d",
                "--name",
                "postgres",
                "--network",
                "agent-ci-net",
                "-e",
                "POSTGRES_PASSWORD=postgres",
                "-p",
                "15432:5432",
                "--health-cmd",
                "pg_isready",
                "--label",
                "agent-ci=true",
                "postgres:16",
            ]
        );
    }

    #[test]
    fn builds_docker_network_and_remove_args() {
        assert_eq!(
            docker_network_create_args("agent-ci-net"),
            vec!["network", "create", "agent-ci-net"]
        );
        assert_eq!(
            docker_network_remove_args("agent-ci-net"),
            vec!["network", "rm", "agent-ci-net"]
        );
        assert_eq!(docker_rm_force_args("runner"), vec!["rm", "-f", "runner"]);
    }

    #[test]
    fn docker_cli_runtime_can_create_and_remove_network_when_opted_in() {
        if std::env::var("AGENT_CI_RUST_DOCKER_INTEGRATION").as_deref() != Ok("1") {
            return;
        }
        let name = format!("agent-ci-rust-test-{}", std::process::id());
        let mut runtime = DockerCliRuntime::default();

        runtime.create_network(&name).unwrap();
        runtime.remove_network(&name).unwrap();
    }

    #[test]
    fn rewrites_loopback_dtu_url_for_containers() {
        assert_eq!(
            resolve_docker_api_url("http://127.0.0.1:1234", "host.docker.internal"),
            "http://host.docker.internal:1234"
        );
    }

    #[test]
    fn resolves_default_extra_hosts() {
        let env = BTreeMap::new();
        assert_eq!(
            resolve_docker_extra_hosts(&env, "host.docker.internal"),
            Some(vec!["host.docker.internal:host-gateway".to_owned()])
        );
    }
}
