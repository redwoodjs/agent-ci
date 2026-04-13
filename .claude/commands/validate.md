---
description: Run local CI to verify changes before completing work
aliases: [validate]
---

// turbo-all

1. Run agent-ci in the **background** so you can monitor and react to failures:

```bash
pnpm agent-ci-dev run --all -q -p 2>&1
```

Use `run_in_background: true` on the Bash tool. This returns an output file path.

2. Set up a **Monitor** on the output file to catch pass/fail events. The monitor must match **both** failure and completion patterns so it self-exits when agent-ci finishes:

```bash
tail -f <output-file> 2>/dev/null | grep --line-buffered -E "Step failed|passed \(" | while IFS= read -r line; do echo "$line"; echo "$line" | grep -q "passed (" && exit 0; done
```

3. Wait for either a monitor event (failure) or a background task completion notification (success).

4. If a step fails, the runner pauses and waits. **CI was passing before your work started**, so the failure is caused by your changes. Investigate and fix it:

- Read the output file for the full failure details.
- Identify and fix the issue in your code.
- Retry the failed runner (run in background and monitor the output):

```bash
pnpm agent-ci-dev retry --name <runner-name>
```

- If the fix requires re-running from an earlier step:

```bash
pnpm agent-ci-dev retry --name <runner-name> --from-step <N>
```

- Monitor the original output file for the retry results.
- Repeat until the job passes.

5. Once all jobs have passed, you're done.
