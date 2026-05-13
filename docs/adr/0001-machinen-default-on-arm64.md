# Machinen is the default runtime for `runs-on: ubuntu-*` on arm64 hosts

When `@machinen/runtime` resolves (its `optionalDependencies` install
arm64-darwin / arm64-linux only), agent-ci selects machinen ahead of docker
for linux jobs. The selection priority is `[machinen, macos-vm, docker]` —
machinen runs first when available; docker is the fallback for hosts where
machinen's VMM optional dep didn't resolve. On x64 / non-supported hosts,
docker remains the only linux candidate and there's no behavior change.

`AGENT_CI_RUNTIME=docker` is the documented escape hatch for arm64 users
who want to opt back into docker. The env var overrides priority _within_
the candidate set for a job's OS family but does not override OS
classification — setting `AGENT_CI_RUNTIME=docker` on a `runs-on: macos-15`
job still routes through the unsupported-OS skip path.

## Why

Docker-first was the conservative alternative but would have left machinen's
boot-time and isolation advantages behind a flag few users would discover.
Treating optional-dep resolution as the opt-in signal gives the "just
install agent-ci on my M-series mac and it's fast" path zero ceremony,
while leaving Intel and x64 Linux users untouched.

## Consequences

- arm64 mac / linux users see their `runs-on: ubuntu-latest` jobs switch
  substrate on upgrade. Documented in the changeset and release notes.
- Mixed-OS runs that happen to use both macos-vm and machinen on the same
  host do not need to coordinate hardware budget: macos-vm uses
  Virtualization.framework (2-VM cap), machinen uses Hypervisor.framework
  directly (no such cap).
