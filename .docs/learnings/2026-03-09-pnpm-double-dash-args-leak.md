# pnpm passes `--` as a literal argument to child scripts

## Problem

When invoking a script via `pnpm --filter <pkg> start -- <args>`, pnpm includes `--` as a literal element in `process.argv`. The child process sees `process.argv.slice(2)` as `["--", "tests", "--scope", "derive"]` rather than `["tests", "--scope", "derive"]`.

## Finding

This affects any subcommand dispatch that checks `args[0]`. The `--` separator that pnpm requires between its own flags and the script's args leaks through as a real argv element. This is not specific to derive — it applies to any pnpm workspace script.

## Solution

Strip a leading `--` from args before dispatch:

```typescript
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
```

Apply the same pattern anywhere `process.argv` is consumed at module level (e.g., `isWatchMode` checks).

## Context

Discovered in the derive CLI during `derive tests` implementation. The `tests` subcommand never dispatched because `args[0]` was `"--"` instead of `"tests"`. The same bug also affected the `isWatchMode` check at module level. Both were fixed in `derive/src/index.ts`.
