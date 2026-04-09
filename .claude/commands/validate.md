---
description: Run local CI to verify changes before completing work
aliases: [validate]
---

// turbo-all

1. Run agent-ci against all relevant workflows for the current branch:

```bash
npx agent-ci run --all -q -p
```

2. If all jobs passed, you're done.
3. If a job fails, the runner pauses and waits. **CI was passing before your work started**, so the failure is caused by your changes. Investigate and fix it:

- Read the last output lines shown in the failure message.
- Check the runner's log directory (printed when the runner starts) for full logs.
- Identify and fix the issue in your code.
- Retry the failed runner:

```bash
 npx agent-ci retry --name <runner-name>
```

- If the fix requires re-running from an earlier step:

```bash
 npx agent-ci retry --name <runner-name> --from-step <N>
```

- Repeat until the job passes.

4. Once all jobs have passed, you're done.
