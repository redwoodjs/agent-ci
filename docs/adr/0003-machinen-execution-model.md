# Machinen execution model: how a job runs inside a microVM

The docker runtime's `executeLocalJob` boots a container, bind-mounts the
run dir, points the GHA runner at an ephemeral DTU on localhost, polls a
timeline file, and supports pause-on-failure via shared signal files. The
machinen runtime needs the same observable behaviour with a different
substrate. This ADR pins down the substrate-specific decisions so
`executeMachinenJob` can be implemented without re-litigating each one in
review.

ADR 0001 covers selection; ADR 0002 covers how the rootfs is produced
(`docker export` of the same image the docker runtime uses). This ADR
covers everything from VM boot to job-result handoff.

## Boot

`@machinen/runtime.boot({ image, cmd, env, name, liveMounts, timeoutMs })`,
where `image` is the path returned by `bakeFromImage()`. The cmd is
`["/bin/sh", "-c", "sleep infinity"]` — we keep the VM alive as a long
shell session and drive everything through `vm.exec`/`vm.writeFile`. That
inverts the docker model (where the container's CMD is a giant
multi-line entrypoint script) but maps cleanly onto machinen's
exec-over-vsock primitive and gives us per-step exit-code visibility
that docker's stdio streaming can't match.

`name` is the runner name (e.g. `agent-ci-machinen-432-j1`). It doubles
as the lookup key for cross-process `attach({ name })`, which the retry
path needs (§ Pause / retry).

## Networking: host DTU ↔ guest

`startEphemeralDtu` binds the DTU server to `0.0.0.0:<random>` on the
host. The docker container reaches it via `host.docker.internal` or an
`ExtraHosts` mapping. machinen uses gvproxy for user-mode networking;
the guest sees the host at the gvproxy gateway IP **`192.168.127.1`**
(the runtime's `guestAddr` default is `192.168.127.2`; the gateway is
`.1`). gvproxy's user-mode NAT forwards `192.168.127.1:<port>` to the
host's loopback transparently — no `portForward` needed, that primitive
is for the opposite direction.

The runner reaches the DTU at `http://192.168.127.1:<dtuPort>/`,
threaded through:

- `.runner` JSON (`serverUrl` + `gitHubUrl`)
- `.credentials` (`authorizationUrl` + `oAuthEndpointUrl`)
- Env vars consumed by step scripts (`GITHUB_API_URL`, etc.)

These are the same fields `buildContainerEnv` populates today; the only
swap is the hostname.

## Filesystem mounts

machinen's `liveMounts` is the closest analogue to a docker bind mount:
FUSE-over-vsock, bidirectional, host writes are visible to the guest
immediately and vice versa. The only constraint is that guest paths
must live under `/mnt/`. We pick `liveMounts` over `mount` (copy-once
via squashfs+overlay) because:

- Pause/retry requires bidirectional writes (signals dir).
- Step outputs and the timeline are read host-side from files written
  inside the runner's `_diag` dir.
- Workspace edits during retry need to propagate without re-baking
  layers.

| Docker bind                                              | machinen guest path     | Mode | Source                      |
| -------------------------------------------------------- | ----------------------- | ---- | --------------------------- |
| `hostWorkDir → /home/runner/_work`                       | `/mnt/work`             | rw   | `runDir/work`               |
| `shimsDir → /tmp/agent-ci-shims`                         | `/mnt/agent-ci-shims`   | ro   | `runDir/shims`              |
| `signalsDir → /tmp/agent-ci-signals` (paused/retry)      | `/mnt/agent-ci-signals` | rw   | `runDir/signals`            |
| `diagDir → /home/runner/_diag`                           | `/mnt/agent-ci-diag`    | rw   | `runDir/diag`               |
| `toolCacheDir → /opt/hostedtoolcache`                    | `/mnt/hostedtoolcache`  | rw   | `runDir/cache/tool`         |
| `pnpmStoreDir → /home/runner/_work/.pnpm-store`          | `/mnt/pnpm-store`       | rw   | `runDir/cache/pnpm`         |
| `npmCacheDir → /home/runner/.npm`                        | `/mnt/npm-cache`        | rw   | `runDir/cache/npm`          |
| `bunCacheDir → /home/runner/.bun`                        | `/mnt/bun-cache`        | rw   | `runDir/cache/bun`          |
| `playwrightCacheDir → /home/runner/.cache/ms-playwright` | `/mnt/playwright-cache` | rw   | `runDir/cache/playwright`   |
| `warmModulesDir → .../node_modules`                      | `/mnt/warm-modules`     | rw   | `runDir/cache/warm-modules` |

The runner expects fixed conventional paths (`/home/runner/_work`,
`/opt/hostedtoolcache`, etc.), so the guest needs a layer that maps its
`/mnt/...` set to those targets. Two viable approaches; we pick **(a)**:

**(a) Symlinks installed at boot time.** First step inside the guest
(via `vm.exec` after `boot()` returns) creates the symlinks:

```sh
ln -sfn /mnt/work             /home/runner/_work
ln -sfn /mnt/agent-ci-shims   /tmp/agent-ci-shims
ln -sfn /mnt/agent-ci-signals /tmp/agent-ci-signals
ln -sfn /mnt/agent-ci-diag    /home/runner/_diag
ln -sfn /mnt/hostedtoolcache  /opt/hostedtoolcache
# ... etc
```

The runner-image's existing dirs at those paths are blown away by the
symlink (`-f`). This stays local to the guest filesystem and doesn't
require a rebuilt rootfs.

**(b) Bake the symlinks into the rootfs.** Would survive into snapshots
but couples the bake to runtime path conventions; rejected so the bake
stays a faithful copy of the docker image.

## Runner launch

The docker side runs an inline entrypoint script (`buildContainerCmd`)
inside the container CMD. We split that script into discrete `vm.exec`
calls and one `vm.writeFile`:

1. **Install symlinks** (above).
2. **Install git shim**: `mv /usr/bin/git /usr/bin/git.real; cp /mnt/agent-ci-shims/git /usr/bin/git; chmod +x /usr/bin/git`. Identical to docker.
3. **Write `.runner` JSON** via `vm.writeFile("/home/runner/.runner", json)`.
4. **Write `.credentials` JSON** + `.credentials_rsaparams` (the long inline blob in `container-config.ts`). `vm.writeFile` handles base64 escaping so the heredoc gymnastics docker needs aren't needed.
5. **`vm.exec("/home/runner/run.sh")`** with `execTimeoutMs: null` so it lives for the whole job. The exec call's `onStdout` / `onStderr` callbacks stream into the host-side debug-log file (same shape as docker's `container.logs({ follow: true })` pipe). The promise resolves with the runner's exit code when the job completes.

The runner registers itself with the DTU on startup (`POST
/_dtu/start-runner` already happens host-side before launch, same as
docker). The DTU then dispatches the seeded job to the registered
runner over the long-poll handshake; that flow is substrate-agnostic.

## Timeline polling

The DTU writes `timeline.json` and `outputs.json` to the host-side
`logDir`. That's host filesystem — agent-ci already reads it directly,
no guest involvement. The existing `syncTimelineToStore` loop works
unchanged.

## Pause / retry

The docker path uses a shared `signalsDir` as the IPC channel:

- Step wrapper inside the container writes `signalsDir/paused` on
  failure.
- Host polls `fs.existsSync(pausedSignalPath)`; emits `run.paused` event;
  drops into stdin wait or detached mode.
- On retry (Enter key, `agent-ci retry --name X` from another process,
  or an external signal), host writes `signalsDir/retry`.
- Step wrapper polls for the file, re-runs the failed step.

Because `signalsDir` is live-mounted into the guest at
`/mnt/agent-ci-signals`, all of this works identically — host writes
land in the guest's view via FUSE-over-vsock, guest writes land on the
host. No additional plumbing. The step wrapper already targets
`/tmp/agent-ci-signals`, which our boot-time symlink points at
`/mnt/agent-ci-signals`.

Cross-process retry (`agent-ci retry --name X`) reuses the existing
`writeDetachedMarker(runDir)` mechanism — the marker tells a separate
agent-ci process which runDir owns a given runner name, and that
process then `fs.writeFileSync(signalsDir/retry, "")` directly on the
host. The running VM picks it up via the live mount. No
`machinen.attach({ name })` call is needed for retry to work; we'd only
need attach for direct guest interaction from a separate process (which
isn't a current requirement).

## Teardown

`vm.exec("/home/runner/run.sh")` resolves when the runner exits. We
then `vm.kill()` (SIGKILL to the VMM process). Host-side cleanup is
identical to docker: remove temp dirs, close the ephemeral DTU,
detach signal handlers.

## Deferred from this design

These need their own ADRs / tasks once the happy path lands:

- **Service containers** (`jobs.<id>.services`). Easiest path: keep
  service containers on docker (existing
  `startServiceContainers`), expose each service port back to the
  machinen VM via `portForward` (host: docker network port; guest:
  same port at `192.168.127.1`). Hostname-based service references
  (`postgres:5432`) need an `/etc/hosts` entry in the guest. Skip for
  now; jobs that use `services:` fall through to docker via the
  selector's normal precedence.
- **Job-level `container:` directive.** When a workflow specifies
  `container: image: foo`, the docker path swaps to `foo`'s image
  directly. The machinen analogue is to bake `foo`'s rootfs via the
  same `bakeFromImage` pipeline — same code, different `imageId`. Wire
  this once the default path works.
- **Concurrent VM cap.** macos-vm caps at 2 VMs via
  `Virtualization.framework`. machinen uses Hypervisor.framework
  directly (no such cap), but a host can still saturate on RAM. Today
  agent-ci's `concurrencyLimiter` works on job count, not memory; the
  machinen path may want a separate memory-aware throttle once we have
  data.
- **Workspace warming.** The docker path uses
  `warmModulesDir → node_modules` for `~0ms cache`. The same mount
  works on machinen, but the path is rooted under the runner's
  `_work/<repo>/<repo>/node_modules`. Verify it survives the symlink
  layer.

## Why this design

- **Live-mount everything** instead of `mount` (copy-once) because
  pause/retry, output capture, and workspace-during-retry all need
  bidirectional propagation. The snapshot tradeoff (`liveMount` doesn't
  survive snapshot/restore) doesn't apply — we don't snapshot job VMs.
- **Symlink at boot** instead of baking paths into the rootfs because
  the bake is supposed to be a faithful copy of the docker image. ADR
  0002's pre-baked-release-artifact follow-up keeps that property; if
  we baked paths in, the artifact would diverge from docker.
- **One `vm.exec` for run.sh** rather than reproducing the docker
  entrypoint's inline shell. Each subprocess gets a clean exit code
  back to the host, which is more honest about errors than docker's
  "did the container exit zero" heuristic.
- **Shared signals dir** unchanged from docker, because liveMount makes
  it a no-op port. Reusing the existing protocol is cheaper than
  designing a vsock-native retry channel and gets us a working
  pause/retry without new code paths to test.
