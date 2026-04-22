---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Fix: honor step-level `if:` conditions. Previously every step ran regardless of its `if:` clause, because `parseWorkflowSteps` never extracted `step.if` from the workflow, and the server fell back to `condition: "success()"` for every step. Now the condition is forwarded to the runner's EvaluateStepIf, so gates like `if: contains(runner.name, 'blacksmith')`, `if: always()`, and `if: ${{ false }}` behave as they do on real GitHub Actions.
