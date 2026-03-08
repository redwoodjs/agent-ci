# macOS tmpdir symlink causes slug mismatches

## Problem

On macOS, `os.tmpdir()` returns `/var/folders/...` but `process.cwd()` inside a subprocess resolves the symlink to `/private/var/folders/...`. When compute a slug from the cwd path (replacing `/` and `_` with `-`), the slugs differ: `-var-folders-...` vs `-private-var-folders-...`.

## Finding

derive's `getSlugDir(process.cwd())` inside the subprocess computes a slug starting with `-private-var-...`, while the test harness (which created the temp dir via `fs.mkdtempSync(os.tmpdir())`) wrote JSONL fixtures under the `-var-...` slug. derive cannot find the conversations because the slug directories don't match.

## Solution

Call `fs.realpathSync()` on the temp root immediately after `mkdtempSync()`. All paths derived from it then match what the subprocess sees.

```typescript
const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "derive-test-")));
```

## Context

Discovered while building the derive e2e test harness. The symptom was "slug dir does not exist -- no conversations to discover" despite the JSONL files existing at the expected path.
