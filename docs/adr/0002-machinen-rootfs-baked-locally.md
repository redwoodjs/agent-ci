# Machinen rootfs is baked on the user's machine on first use

agent-ci does not ship or fetch a pre-baked machinen rootfs. The first time
a machinen job runs, `runner/machinen/bake.ts` invokes `provision()` from
`@machinen/runtime` to install a pinned set of packages (`nodejs`, `git`,
`curl`, `ca-certificates`, `build-essential`, plus the GHA runner binary
at a pinned SHA) into a tarball at
`~/.cache/agent-ci/machinen/runner-ubuntu-arm64-<bake-script-sha>.tar.gz`.
Subsequent jobs reuse the cached tarball. Concurrent first-use jobs share
a single in-flight bake promise.

The cache key is the bake-script SHA, so any change to the provisioned
package set or runner-binary pin invalidates user caches automatically on
upgrade.

## Why

The cirruslabs-style alternative — pre-bake the rootfs in CI and ship it
as a GitHub Release artifact — would require standing up release-workflow
infrastructure (arm64 build runner, release-tag baking job, image
versioning policy) as a side-quest to a refactor. Keeping bake local
keeps this PR shippable and defers the infrastructure question to a
follow-up.

## Consequences

- First machinen job for a given user pays ~5-10 minutes of bake cost.
- Rootfs contents depend on whatever apt mirror serves the user at bake
  time. Pinning package versions in the bake script mitigates drift but
  doesn't eliminate it.
- Migrating to pre-baked release artifacts later is interface-preserving:
  flip `image-mapping.ts` to resolve a release URL instead of the local
  cache path. No Runtime-interface change required.
