---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Fix `AGENT_CI_DOCKER_HOST=ssh://...` failing with `getaddrinfo ENOTFOUND`. The runner now parses the SSH URI and passes `host`, `username`, and `port` to dockerode separately instead of handing the raw URI string through as a hostname. Closes #322.
