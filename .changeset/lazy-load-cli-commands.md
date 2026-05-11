---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

perf(cli): lazy-load command modules so light commands skip the heavy dependency graph

Extracts the `run`, `retry`/`abort`, and `clean` commands into separate modules
loaded via dynamic `import()` from `cli.ts`. The dispatcher now only loads what
the invoked command actually needs.

Measured impact on `agent-ci --help`:

- Cold start: 240 ms → 20 ms
- Peak RSS: 88 MB → 42 MB

`--help` and unknown commands no longer load dockerode, @grpc/grpc-js,
protobufjs, ssh2, the runner graph, or the workflow parser. Behavior of every
command is unchanged; `--help`/`-h` now exits 0 (previously 1, which was a
quirk of falling through the dispatch chain).

Refs #334.
