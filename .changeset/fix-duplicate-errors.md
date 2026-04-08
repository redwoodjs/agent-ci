---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Fix duplicate error messages on workflow failure by removing the intermediate console.error in handleWorkflow's catch block.
