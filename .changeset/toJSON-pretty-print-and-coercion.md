---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Two small expression-engine fixes surfaced while running through #296's "questionable claim" rows:

1. **`toJSON` now pretty-prints with 2-space indent** to match GitHub Actions. Previously emitted compact JSON, which meant that any `hashFiles` key that consumed `toJSON(x)` would hash to a different digest locally vs. on GitHub. Parses `rawValue` before re-serialising so `toJSON(fromJSON(x))` round-trips.
2. **`''`, `null`, and numeric strings now coerce in comparisons** per the spec: `'' == 0`, `null == 0`, `'0' == 0` are all `true`; `'x' == 0` stays `false` because non-numeric strings become `NaN`. Previously, empty/null on either side fell out of the numeric path and was string-compared, so `'' == 0` resolved to `false`.

Refs #296.
