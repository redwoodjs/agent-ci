
## Drafted Implementation Plan to Fix "No plugin could prepare document" [2026-02-04]

### Problem
Empty Discord `.jsonl` files cause `discordPlugin` to return `null`. Since no other plugin matches, `prepareDocumentForR2Key` throws an error that pauses the simulation (or requires infra retries).

### Solution
1. Modify `discordPlugin` to return a `Document` with empty content even if messages are empty, provided the key matches.
2. Implement a catch-all `prepareSourceDocument` in `defaultPlugin` to handle any unrecognized files gracefully.
3. Update `defaultPlugin` to produce a single empty chunk for empty documents to satisfy the "must have at least one chunk" constraint.

### Planned Changes
- [MODIFY] `src/app/engine/plugins/discord.ts`: Return `Document` for empty `.jsonl` files.
- [MODIFY] `src/app/engine/plugins/default.ts`: Add `prepareSourceDocument` catch-all and robust chunking.

### Verification
- Run a simulation with a known empty Discord file and observe successful transition to next phase.


## Fix Implemented [2026-02-04]
We have updated both `discordPlugin` and `defaultPlugin` to handle empty files and unrecognized keys:
1. `discordPlugin` now returns an empty document if a matched `.jsonl` file contains no messages.
2. `defaultPlugin` now includes a catch-all `prepareSourceDocument` hook.
3. `defaultPlugin.splitDocumentIntoChunks` now ensures at least one chunk is produced even for empty content.
4. Added `"unknown"` to the `Source` type union in `src/app/engine/types.ts`.

These changes prevent the "No plugin could prepare document" and "No plugin could split document into chunks" errors that were stalling simulations in production.
