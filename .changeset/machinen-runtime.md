---
"@redwoodjs/agent-ci": minor
"dtu-github-actions": minor
---

feat(runner): introduce machinen runtime (opt-in)

Adds a third runtime for `runs-on: ubuntu-*` jobs on arm64 hosts —
microVMs via [`@machinen/runtime`](https://github.com/redwoodjs/machinen).
Opt-in for now (`AGENT_CI_MACHINEN=1`); docker remains the default.
See ADRs 0001 / 0002 / 0003 / 0004 in `docs/adr/` for the design.

What ships:

- **Runtime selection (ADR 0001).** New `Runtime` interface + registry
  in `packages/cli/src/runner/runtime.ts`. Priority order
  `[machinen, macos-vm, docker]`, with `AGENT_CI_RUNTIME` as a
  within-OS-family override. The selector is wired into `run.ts` in
  place of the previous docker-or-macos-vm `if`/`else`.
- **Rootfs as a release asset (ADR 0004).** The runtime downloads
  agent-ci's pre-baked rootfs from
  `https://github.com/redwoodjs/agent-ci/releases/download/machinen-rootfs-latest/agent-ci-machinen-runner-arm64.tar.gz`
  on first machinen use and caches at
  `~/.cache/agent-ci/machinen/base.tar.gz`. Subsequent runs do a
  conditional GET (`If-None-Match`) so re-bakes propagate without a
  full re-download. The runtime falls back to the cached copy if the
  network is unreachable.
- **User override.** If `<repoRoot>/.github/agent-ci.machinen.tar.gz`
  exists, that file is used verbatim — no download, no overlay. Lets
  users hand-build their own machinen rootfs without touching agent-ci.
- **Release-time bake.** `scripts/machinen-bake.mjs` and
  `.github/workflows/machinen-rootfs.yml` produce the rootfs asset and
  upload it to the `machinen-rootfs-latest` rolling release.
  Manually triggered (`workflow_dispatch`); re-run on upstream
  `actions/runner` bumps or apt updates.
- **executeMachinenJob (end-to-end).** Boots a long-lived VM from the
  resolved rootfs with `liveMounts` for work/shims/diag (+ signals
  when `--pause-on-failure`); installs symlinks (`/home/runner/_work →
/mnt/work` etc.) and the git shim via `vm.exec`; writes
  `.runner`/`.credentials`/`.credentials_rsaparams` via `vm.writeFile`;
  registers + seeds the runner with the per-job ephemeral DTU
  (reachable from the guest at `192.168.127.254:<port>` through
  gvproxy's user-mode NAT); launches `run.sh --once` with
  `RUNNER_ALLOW_RUNASROOT=1`; streams stdout/stderr into the debug
  log; polls `timeline.json` via the shared `timeline-sync` module
  (extracted from `local-job.ts`); tears the VM down on completion.
- **Pause-on-failure + retry** rides the same `signalsDir` filesystem
  protocol the docker path uses. The signals dir is `liveMount`ed
  into the guest at `/mnt/signals` and symlinked from
  `/tmp/agent-ci-signals` at boot, so the wrapper's
  `paused` / `step-output` writes propagate to the host and host-side
  `retry` / `abort` writes propagate back into the guest — verified
  end-to-end against the failing-step workflow.

Behavior on existing installs:

- **Docker users see no change.** `AGENT_CI_MACHINEN` is unset by
  default, machinen's host capability check returns "not enabled", and
  the selector picks docker exactly as before.
- **macos-vm users see no change.** macOS jobs continue to route
  through the macos-vm runtime when supported.

Operational note: the `pnpm-workspace.yaml` adds `@machinen/*` to
`minimumReleaseAgeExclude` so the global 7-day supply-chain guard
doesn't block install on first-party packages co-authored by the same
maintainers.
