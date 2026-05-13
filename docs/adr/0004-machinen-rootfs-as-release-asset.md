# Machinen rootfs ships as a GitHub Release asset

ADR 0002 said agent-ci would bake the machinen rootfs on the user's
machine the first time a machinen job runs, and noted "pre-baking and
shipping the artifact" as a deferred follow-up. This ADR is that
follow-up.

agent-ci publishes a single pre-baked rootfs tarball as a GitHub Release
asset on `redwoodjs/agent-ci`. At runtime the machinen path either
downloads it (default) or uses a user-supplied tarball at
`.github/agent-ci.machinen.tar.gz` (override). Either way machinen sees
exactly one ready-to-boot rootfs — there's no runtime layering, no
auto-translated Dockerfile, no per-job provision pass.

## Asset shape

- **Filename:** `agent-ci-machinen-runner-arm64.tar.gz`
- **Hosting:** released asset on `redwoodjs/agent-ci`. Fetched via
  `https://github.com/redwoodjs/agent-ci/releases/download/<tag>/agent-ci-machinen-runner-arm64.tar.gz`.
  Public repo, anonymous fetch — no `gh auth` required on the user side.
- **Versioning:** the runtime fetches from a moving `machinen-rootfs-latest`
  release tag rather than pinning to the agent-ci package version. We
  re-bake the asset as upstream `actions/runner` and the package set
  drift; users get the latest baked rootfs without bumping agent-ci.
  Cache key on disk is the asset's content-SHA (read via a HEAD against
  the GitHub release API), so a re-bake invalidates user caches on next
  run.
- **Content:** debian-arm64 + machinen guest tooling (`/sbin/machinen-supervisor`
  et al.) + the same package set the bake currently produces
  (`nodejs git curl ca-certificates jq unzip` + GHA runner binary at
  the pinned version). Roughly content-parity with
  `ghcr.io/actions/actions-runner:latest`, minus anything not apt-installable.

## User override: `.github/agent-ci.machinen.tar.gz`

If `<repoRoot>/.github/agent-ci.machinen.tar.gz` exists, agent-ci uses
it as the rootfs verbatim — no download, no overlay. The user is
responsible for the file being machinen-compatible (debian arm64 +
`/sbin/machinen-supervisor` + their workload). The expected production
path is "user `gh release download`s our published base, runs their
own `machinen bake` against it, drops the result in `.github/`" — or
checks in a build script that does the same.

Mirrors the docker runtime's `.github/agent-ci.Dockerfile` convention:
agent-ci looks in `.github/` for a per-repo override of the runtime's
default, no flag required.

Cache invalidation for the override path is the file's content-SHA on
disk — same shape as the download path.

## What we explicitly do NOT do

- **No automatic Dockerfile translation.** The docker runtime's
  `.github/agent-ci.Dockerfile` is for the docker runtime; it is not
  re-interpreted for machinen. An earlier draft of this design tried
  to parse RUN apt-get install lines and layer them via
  `provision({ base, install })`; we dropped it because the
  translation was inherently lossy (no COPY, no custom RUN, no FROM
  drift), and a power-user escape hatch (the override above) makes
  the magic redundant.
- **No runtime layering / provision pass.** Cold start = download
  base (or read user override). Warm = read cache. Boot. No
  in-between.
- **No parallel docker image.** The docker runtime keeps using
  `ghcr.io/actions/actions-runner:latest`. There is nothing agent-ci
  needs to layer onto the upstream container.

## Why latest-tag, not per-version

- The rootfs content drifts on upstream cadence (apt mirror, runner
  binary release), not agent-ci's. Pinning to agent-ci's version would
  freeze the rootfs at agent-ci release time and accumulate drift
  until the next agent-ci bump.
- The asset is large (~300 MB) and we don't want one copy per agent-ci
  version inflating release storage.
- The content-SHA cache key means a user's cache only invalidates when
  the rootfs actually changes — agent-ci upgrades don't force a
  re-download unless the rootfs itself moved.

## Runtime flow

1. **Override check:** if `<repoRoot>/.github/agent-ci.machinen.tar.gz`
   exists, that's the rootfs. Done.
2. **Download base if missing:**
   - HEAD `.../releases/download/machinen-rootfs-latest/<filename>`
     for the content-SHA.
   - If `~/.cache/agent-ci/machinen/base-<contentSha>.tar.gz` exists,
     use it.
   - Otherwise stream the body to `<path>.partial`, atomic rename.
     Single-flight on cold first use.
3. `boot({ image: <rootfsPath>, ... })`.

The user override and the download both produce a single tarball path
that flows into `boot()`. No branching downstream.

## Release workflow

Add a release-time job to `redwoodjs/agent-ci`'s CI:

1. Spin up an arm64 host (M-series mac runner, or arm64-linux).
2. `pnpm install` agent-ci.
3. Run a thin `pnpm machinen:bake` script that produces
   `agent-ci-machinen-runner-arm64.tar.gz`. The script lives
   under `scripts/` and uses `@machinen/runtime.provision()` directly
   with our pinned package list + GHA runner binary URL. It is
   release-only tooling, not shipped to users.
4. `gh release upload machinen-rootfs-latest agent-ci-machinen-runner-arm64.tar.gz --clobber`.

The `machinen-rootfs-latest` release is a hand-managed "rolling" tag.
Tag bumps happen when we want to refresh the rootfs (upstream runner
bump, new package in the spec, security update).

## Consequences

- **First-run UX for machinen flips from "cold bake takes minutes" to
  "cold download takes seconds"** (asset is ~300 MB; throttled by
  upstream HTTPS and disk write speed but not by apt / VM boot).
  Warm runs unchanged.
- **The user-facing runtime `bakeRootfs()` codepath collapses to a
  download.** The full provision pipeline (provision against
  machinen-debian + GHA runner download) moves out of
  `packages/cli/src/runner/machinen/bake.ts` into a release-only
  script under `scripts/`.
- **`dockerfile-overlay.ts` and its tests are deleted.** The parser
  and overlay-only provision branch are no longer reachable. Users who
  need extras either: (a) drop their own
  `.github/agent-ci.machinen.tar.gz`, or (b) run the job through the
  docker runtime (`AGENT_CI_RUNTIME=docker`).
- **We take on the operational responsibility of keeping the asset
  fresh.** If `machinen-rootfs-latest` falls behind a security-
  relevant apt update, every machinen user is stuck on a stale base
  until we re-bake.
- **We're committing to keep the rootfs `actions/actions-runner`-compatible
  in content.** If a workflow runs green on the docker runtime today,
  the same content should be present in our pre-baked machinen rootfs.

## Open questions for the implementation PRs

- How do we test the asset end-to-end in CI without re-baking on every
  PR? Probably: re-bake only on `main` or on a manually-triggered
  workflow; PRs use the most recent release.
- Should the `machinen-rootfs-latest` release also publish the base
  rootfs for non-arm64-linux platforms eventually (e.g. arm64 inside a
  cross-arch macOS bake)? Out of scope here; just naming the file with
  the arch so it's easy to add `_x64` later.
- Asset integrity: the runtime should verify the downloaded body
  against the GitHub release API's SHA-256. ADR 0002's `.partial` →
  final rename pattern is preserved.
