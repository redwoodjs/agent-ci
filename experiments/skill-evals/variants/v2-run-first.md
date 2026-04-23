---
name: agent-ci
description: Run GitHub Actions CI locally with Agent CI to validate changes before pushing. Use when testing, running checks, or validating code changes.
license: MIT
compatibility: Requires Node.js 18+ and Docker
metadata:
  author: redwoodjs
  version: "1.0.0"
---

# Agent CI

Run the full CI pipeline locally before pushing. CI was green before you started — any failure is caused by your changes.

## Procedure

When CI is failing, or when you need to validate a change, **run this command first — before inspecting files, before guessing, before editing anything**:

```bash
npx @redwoodjs/agent-ci run --quiet --all --pause-on-failure
```

The `--pause-on-failure` flag is **required**, not optional. It keeps the container alive with full state on failure so you can fix and retry the failed step without a fresh install. Do not omit it.

Read the output. The failing step's logs tell you exactly what broke. Do not infer the problem from the source file alone — the CI output is the source of truth.

## Retry after fixing

When a step fails, the run pauses. Fix the file on your host (edits sync into the container), then retry **only the failed step**:

```bash
npx @redwoodjs/agent-ci retry --name <runner-name>
```

To re-run from an earlier step:

```bash
npx @redwoodjs/agent-ci retry --name <runner-name> --from-step <N>
```

Repeat **run → fix → retry** until all jobs pass. Do not push to trigger remote CI when agent-ci can run it locally.

## Do not

- **Do not skip running agent-ci** because the fix "looks obvious." The eval is whether agent-ci passes, not whether the code looks right.
- **Do not disable lint rules, delete failing tests, or remove CI steps** to make CI pass. Fix the underlying issue.
- **Do not omit `--pause-on-failure`** — it's what makes the retry loop fast.
- **Do not pipe the output through `tail` or `head`** — it buffers everything until exit and disables pause-on-failure interaction.
