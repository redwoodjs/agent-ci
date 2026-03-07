export interface ContainerEnvOpts {
  containerName: string;
  registrationToken: string;
  repoUrl: string;
  dockerApiUrl: string;
  githubRepo: string;
  headSha?: string;
  dtuHost: string;
  useDirectContainer: boolean;
}

export interface ContainerBindsOpts {
  hostWorkDir: string;
  shimsDir: string;
  diagDir: string;
  toolCacheDir: string;
  pnpmStoreDir: string;
  playwrightCacheDir: string;
  warmModulesDir: string;
  hostRunnerDir: string;
  useDirectContainer: boolean;
}

export interface ContainerCmdOpts {
  svcPortForwardSnippet: string;
  dtuPort: string;
  useDirectContainer: boolean;
}

// ─── Environment variables ────────────────────────────────────────────────────

/**
 * Build the Env array for `docker.createContainer()`.
 */
export function buildContainerEnv(opts: ContainerEnvOpts): string[] {
  const {
    containerName,
    registrationToken,
    repoUrl,
    dockerApiUrl,
    githubRepo,
    headSha,
    dtuHost,
    useDirectContainer,
  } = opts;

  return [
    `RUNNER_NAME=${containerName}`,
    `RUNNER_TOKEN=${registrationToken}`,
    `RUNNER_REPOSITORY_URL=${repoUrl}`,
    `GITHUB_API_URL=${dockerApiUrl}`,
    `GITHUB_SERVER_URL=${repoUrl}`,
    `GITHUB_REPOSITORY=${githubRepo}`,
    `MACHINEN_LOCAL_SYNC=true`,
    `MACHINEN_HEAD_SHA=${headSha || "HEAD"}`,
    `MACHINEN_DTU_HOST=${dtuHost}`,
    `ACTIONS_CACHE_URL=${dockerApiUrl}/`,
    `ACTIONS_RESULTS_URL=${dockerApiUrl}/`,
    `ACTIONS_RUNTIME_TOKEN=mock_cache_token_123`,
    `RUNNER_TOOL_CACHE=/opt/hostedtoolcache`,
    `PATH=/home/runner/externals/node24/bin:/home/runner/externals/node20/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    // Force colour output in all child processes (pnpm, Node, etc.)
    `FORCE_COLOR=1`,
    // Custom containers may run as root and lack libicu — configure accordingly
    ...(useDirectContainer
      ? [`RUNNER_ALLOW_RUNASROOT=1`, `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1`]
      : []),
  ];
}

// ─── Bind mounts ──────────────────────────────────────────────────────────────

/**
 * Build the Binds array for `docker.createContainer()`.
 */
export function buildContainerBinds(opts: ContainerBindsOpts): string[] {
  const {
    hostWorkDir,
    shimsDir,
    diagDir,
    toolCacheDir,
    pnpmStoreDir,
    playwrightCacheDir,
    warmModulesDir,
    hostRunnerDir,
    useDirectContainer,
  } = opts;

  return [
    // When using a custom container, bind-mount the extracted runner
    ...(useDirectContainer ? [`${hostRunnerDir}:/home/runner`] : []),
    `${hostWorkDir}:/home/runner/_work`,
    "/var/run/docker.sock:/var/run/docker.sock",
    `${shimsDir}:/tmp/machinen-shims`,
    `${diagDir}:/home/runner/_diag`,
    `${toolCacheDir}:/opt/hostedtoolcache`,
    `${pnpmStoreDir}:/home/runner/_work/.pnpm-store`,
    `${playwrightCacheDir}:/home/runner/.cache/ms-playwright`,
    // Warm node_modules: mounted outside the workspace so actions/checkout can
    // delete the symlink without EBUSY. A symlink in the entrypoint points
    // workspace/node_modules → /tmp/warm-modules.
    `${warmModulesDir}:/tmp/warm-modules`,
  ];
}

// ─── Container command ────────────────────────────────────────────────────────

/**
 * Build the long entrypoint command string for the container.
 */
export function buildContainerCmd(opts: ContainerCmdOpts): string[] {
  const { svcPortForwardSnippet, dtuPort, useDirectContainer } = opts;

  const cmdScript = `MAYBE_SUDO() { if command -v sudo >/dev/null 2>&1; then sudo -n "$@"; else "$@"; fi; }; MAYBE_SUDO chmod -R 777 /home/runner/_work /home/runner/_diag 2>/dev/null || true && if [ -f /usr/bin/git ]; then MAYBE_SUDO mv /usr/bin/git /usr/bin/git.real 2>/dev/null; MAYBE_SUDO cp /tmp/machinen-shims/git /usr/bin/git 2>/dev/null; fi && ${svcPortForwardSnippet}echo "[Machinen] Starting DTU proxy (port 80 -> ${dtuPort})..." && PROXY_T0=$(date +%s%3N) && node -e "
const net=require('net');
const srv=net.createServer(c=>{
  const s=net.connect(${dtuPort},'$MACHINEN_DTU_HOST',()=>{c.pipe(s);s.pipe(c)});
  s.on('error',()=>c.destroy());c.on('error',()=>s.destroy());
});
srv.listen(80,'127.0.0.1',()=>process.stdout.write(''));
" & PROXY_PID=$! && for i in $(seq 1 100); do nc -z 127.0.0.1 80 2>/dev/null && break; sleep 0.1; done && echo "[Machinen] DTU proxy ready in $(($(date +%s%3N) - PROXY_T0))ms" && chmod 666 /var/run/docker.sock 2>/dev/null || true && RESOLVED_URL="http://127.0.0.1:80/$GITHUB_REPOSITORY" && export GITHUB_API_URL="http://127.0.0.1:80" && export GITHUB_SERVER_URL="https://github.com" && cd /home/runner && ./config.sh remove --token "$RUNNER_TOKEN" 2>/dev/null || true && ./config.sh --url "$RESOLVED_URL" --token "$RUNNER_TOKEN" --name "$RUNNER_NAME" --unattended --ephemeral --work _work --labels machinen || echo "Config warning: Service generation failed, proceeding..." && REPO_NAME=$(basename $GITHUB_REPOSITORY) && WORKSPACE_PATH=/home/runner/_work/$REPO_NAME/$REPO_NAME && MAYBE_SUDO chmod -R 777 $WORKSPACE_PATH 2>/dev/null || true && mkdir -p $WORKSPACE_PATH && ln -sfn /tmp/warm-modules $WORKSPACE_PATH/node_modules && echo "Workspace ready (direct bind-mount): $(ls $WORKSPACE_PATH 2>/dev/null | wc -l) files" && ./run.sh --once`;

  return [...(useDirectContainer ? ["-c"] : ["bash", "-c"]), cmdScript];
}

// ─── DTU host resolution ──────────────────────────────────────────────────────

import fs from "fs";
import { execSync } from "child_process";

/**
 * Resolve the DTU host address that nested Docker containers can reach.
 * Inside Docker: use the container's own bridge IP.
 * On host: use `host.docker.internal`.
 */
export function resolveDtuHost(): string {
  const isInsideDocker = fs.existsSync("/.dockerenv");
  if (!isInsideDocker) {
    return "host.docker.internal";
  }
  try {
    const ip = execSync("hostname -I 2>/dev/null | awk '{print $1}'", {
      encoding: "utf8",
    }).trim();
    if (ip) {
      return ip;
    }
  } catch {}
  return "172.17.0.1"; // fallback to bridge gateway
}

/**
 * Rewrite a DTU URL to be reachable from inside Docker containers.
 */
export function resolveDockerApiUrl(dtuUrl: string, dtuHost: string): string {
  return dtuUrl.replace("localhost", dtuHost).replace("127.0.0.1", dtuHost);
}
