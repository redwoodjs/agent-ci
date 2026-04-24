---
"@redwoodjs/agent-ci": minor
"dtu-github-actions": patch
---

Revert the opt-in smolvm backend (#287). The implementation proved too rough
to keep in-tree while iterating — it will return once the boot path is
reliable on the current smolvm release. `AGENT_CI_BACKEND=smolvm` is no
longer recognized; Linux jobs always run through Docker.
