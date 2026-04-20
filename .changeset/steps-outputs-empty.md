---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Stop leaking literal `${{ steps.<id>.outputs.<name> }}` text into `run:` scripts. The parser used to leave these expressions untouched on the premise that the runner would evaluate them at runtime, but the runner does not re-evaluate expressions inside run-script bodies — the literal `${{ }}` reached bash and produced "bad substitution" errors. The expression now resolves to an empty string at parse time, matching the long-standing documented behavior.

Use `needs.*.outputs.*` for cross-job values — those are resolved against real job outputs.

Closes #295.
