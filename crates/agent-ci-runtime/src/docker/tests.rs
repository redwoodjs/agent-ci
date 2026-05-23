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
