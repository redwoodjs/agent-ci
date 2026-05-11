---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

perf(cli): parallelize the startup git calls

The first thing `agent-ci run` does is ask git for several pieces of
information: the current branch, the head commit SHA, the changed
files, the remote slug, and (when the tree is dirty) an ephemeral
commit that captures the working-tree state. Each call shelled out to
`execSync`, blocking the event loop for ~50–200 ms.

This change converts each of those helpers to use `execFile` via
`promisify`, so they return promises. `handleWorkflow` then runs them
concurrently with `Promise.all` instead of one at a time.

Functions converted:

- `getFirstRemoteUrl` and `resolveRepoSlug` in `config.ts`
- `computeDirtySha` in `runner/dirty-sha.ts`
- `getChangedFiles` in `workflow/workflow-parser.ts`
- `resolveHeadSha`, `resolveBaseSha`, and `persistRunResult` in
  `commands/run.ts`

Switching from `execSync(command-string)` to `execFile("git", [args])`
also removes a shell escaping step on every call — args are passed as
an array, not a single string.

Refs #334.
