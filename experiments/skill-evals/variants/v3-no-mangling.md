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

## Run

```bash
npx @redwoodjs/agent-ci run --quiet --all --pause-on-failure
```

Run this command **directly**. Do not redirect its output.

Specifically:

- **No pipes.** `| tail -N`, `| head -N`, `| grep`, `| cat`, `| tee`, anything — the shell buffers the whole stream and agent-ci's pause message never reaches you. The run will appear to hang.
- **No file redirects.** `> log.txt`, `&> log.txt`, `> /dev/null` — same problem. You will see nothing until the process exits, which won't happen until you issue retry.
- **No backgrounding.** No trailing `&`, no `& sleep 20`. Pause-on-failure needs a live channel back to you.

Bare `2>&1` (merge stderr into stdout) on its own is fine — it doesn't redirect or buffer. Anything _after_ a `2>&1` (a pipe, a file, an `&`) is not.

If the output is long, let it be long. Read it.

## After a failure

When a step fails, agent-ci pauses. The output tells you which runner paused and what retry command to issue. Fix the file on your host, then:

```bash
npx @redwoodjs/agent-ci retry --name <runner-name>
```

To re-run from an earlier step:

```bash
npx @redwoodjs/agent-ci retry --name <runner-name> --from-step <N>
```

Retry the same way — **directly**, no pipes or redirects.

## Do not

- Do not skip running agent-ci because the fix "looks obvious" from the file. The only thing that proves the fix works is a green agent-ci run.
- Do not disable lint rules, delete failing tests, or remove CI steps to make it pass. Fix the underlying issue.
- Do not omit `--pause-on-failure`. It is what makes the fix/retry loop fast; without it the container tears down and the next run pays the full startup cost again.
