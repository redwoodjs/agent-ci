---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

fix(macos-vm): let `waitForIp` retry on cold-boot `tart ip` timeouts

`getIp` swallows the `runCommand` rejection that fires when `tart ip` hangs past 5s waiting for a DHCP lease, so `waitForIp` can keep polling for the full 90s budget instead of dying on the first iteration.

Fixes #329.
