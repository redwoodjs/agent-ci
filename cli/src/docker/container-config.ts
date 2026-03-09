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
  signalsDir?: string;
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
  containerName: string;
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
    signalsDir,
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
    // Pause-on-failure IPC: signal files (paused, retry, abort)
    ...(signalsDir ? [`${signalsDir}:/tmp/machinen-signals`] : []),
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
  const { svcPortForwardSnippet, dtuPort, useDirectContainer, containerName } = opts;

  // For direct containers, credentials are pre-baked on the host and bind-mounted
  // into /home/runner. For the default image, we write them inline in the
  // entrypoint since /home/runner is baked into the image.
  const credentialSnippet = useDirectContainer
    ? ""
    : `echo '{"agentId":1,"agentName":"${containerName}","poolId":1,"poolName":"Default","serverUrl":"http://127.0.0.1:80","gitHubUrl":"http://127.0.0.1:80/'$GITHUB_REPOSITORY'","workFolder":"_work","ephemeral":true}' > /home/runner/.runner && echo '{"scheme":"OAuth","data":{"clientId":"00000000-0000-0000-0000-000000000000","authorizationUrl":"http://127.0.0.1:80/_apis/oauth2/token","oAuthEndpointUrl":"http://127.0.0.1:80/_apis/oauth2/token","requireFipsCryptography":"False"}}' > /home/runner/.credentials && echo '{"d":"CQpCI+sO2GD1N/JsHHI9zEhMlu5Fcc8mU4O2bO6iscOsagFjvEnTesJgydC/Go1HuOBlx+GT9EG2h7+juS0z2o5n8Mvt5BBxlK+tqoDOs8VfQ9CSUl3hqYRPeNdBfnA1w8ovLW0wqfPO08FWTLI0urYsnwjZ5BQrBM+D7zYeA0aCsKdo75bKmaEKnmqrtIEhb7hE45XQa32Yt0RPCPi8QcQAY2HLHbdWdZYDj6k/UuDvz9H/xlDzwYq6Yikk2RSMArFzaufxCGS9tBZNEACDPYgnZnEMXRcvsnZ9FYbq81KOSifCmq7Yocq+j3rY5zJCD+PIDY9QJwPxB4PGasRKAQ==","dp":"A0sY1oOz1+3uUMiy+I5xGuHGHOrEQPYspd1xGClBYYsa/Za0UDWS7V0Tn1cbRWfWtNe5vTpxcvwQd6UZBwrtHF6R2zyXFhE++PLPhCe0tH4C5FY9i9jUw9Vo8t44i/s5JUHU2B1mEptXFUA0GcVrLKS8toZSgqELSS2Q/YLRxoE=","dq":"GrLC9dPJ5n3VYw51ghCH7tybUN9/Oe4T8d9v4dLQ34RQEWHwRd4g3U3zkvuhpXFPloUTMmkxS7MF5pS1evrtzkay4QUTDv+28s0xRuAsw5qNTzuFygg8t93MvpvTVZ2TNApW6C7NFvkL9NbxAnU8+I61/3ow7i6a7oYJJ0hWAxE=","exponent":"AQAB","inverseQ":"8DVz9FSvEdt5W4B9OjgakZHwGfnhn2VLDUxrsR5ilC5tPC/IgA8C2xEfKQM1t+K/N3pAYHBYQ6EPgtW4kquBS/Sy102xbRI7GSCnUbRtTpWYPOaCn6EaxBNzwWzbp5vCbCGvFqlSu4+OBYRVe+iCj+gAnkmT/TKPhHHbTjJHvw==","modulus":"x0eoW2DD7xsW5YiorMN8pNHVvZk4ED1SHlA/bmVnRz5FjEDnQloMn0nBgIUHxoNArksknrp/FOVJv5sJHJTiRZkOp+ZmH7d3W3gmw63IxK2C5pV+6xfav9jR2+Wt/6FMYMgG2utBdF95oif1f2XREFovHoXkWms2l0CPLLHVPO44Hh9EEmBmjOeMJEZkulHJ44z9y8e+GZ2nYqO0ZiRWQcRObZ0vlRaGg6PPOl4ltay0BfNksMB3NDtlhkdVkAEFQxEaZZDK9NtkvNljXCioP3TyTAbqNUGsYCA5D+IHGZT9An99J9vUqTFP6TKjqUvy9WNiIzaUksCySA0a4SVBkQ==","p":"8fgAdmWy+sTzAN19fYkWMQqeC7t1BCQMo5z5knfVLg8TtwP9ZGqDtoe+r0bGv3UgVsvvDdP/QwRvRVP+5G9l999Y6b4VbSdUbrfPfOgjpPDmRTQzHDve5jh5xBENQoRXYm7PMgHGmjwuFsE/tKtSGTrvt2Z3qcYAo0IOqLLhYmE=","q":"0tXx4+P7gUWePf92UJLkzhNBClvdnmDbIt52Lui7YCARczbN/asCDJxcMy6Bh3qmIx/bNuOUrfzHkYZHfnRw8AGEK80qmiLLPI6jrUBOGRajmzemGQx0W8FWalEQfGdNIv9R2nsegDRoMq255Zo/qX60xQ6abpp0c6UNhVYSjTE="}' > /home/runner/.credentials_rsaparams && `;

  const cmdScript = `MAYBE_SUDO() { if command -v sudo >/dev/null 2>&1; then sudo -n "$@"; else "$@"; fi; }; MAYBE_SUDO chmod -R 777 /home/runner/_work /home/runner/_diag 2>/dev/null || true && if [ -f /usr/bin/git ]; then MAYBE_SUDO mv /usr/bin/git /usr/bin/git.real 2>/dev/null; MAYBE_SUDO cp /tmp/machinen-shims/git /usr/bin/git 2>/dev/null; fi && ${svcPortForwardSnippet}echo "[Machinen] Starting DTU proxy (port 80 -> ${dtuPort})..." && PROXY_T0=$(date +%s%3N) && node -e "
const net=require('net');
const srv=net.createServer(c=>{
  const s=net.connect(${dtuPort},'$MACHINEN_DTU_HOST',()=>{c.pipe(s);s.pipe(c)});
  s.on('error',()=>c.destroy());c.on('error',()=>s.destroy());
});
srv.listen(80,'127.0.0.1',()=>process.stdout.write(''));
" & PROXY_PID=$! && for i in $(seq 1 100); do nc -z 127.0.0.1 80 2>/dev/null && break; sleep 0.1; done && echo "[Machinen] DTU proxy ready in $(($(date +%s%3N) - PROXY_T0))ms" && chmod 666 /var/run/docker.sock 2>/dev/null || true && cd /home/runner && ${credentialSnippet}REPO_NAME=$(basename $GITHUB_REPOSITORY) && WORKSPACE_PATH=/home/runner/_work/$REPO_NAME/$REPO_NAME && MAYBE_SUDO chmod -R 777 $WORKSPACE_PATH 2>/dev/null || true && mkdir -p $WORKSPACE_PATH && ln -sfn /tmp/warm-modules $WORKSPACE_PATH/node_modules && echo "Workspace ready (direct bind-mount): $(ls $WORKSPACE_PATH 2>/dev/null | wc -l) files" && ./run.sh --once`;

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
