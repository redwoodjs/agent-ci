# Mixed Sampling and Specific Document Selection in Simulation 2026-01-27

## Started work on mixed sampling and specific document selection
We are implementing the ability to include specific R2 keys (manual input) alongside a sampled set of documents in a simulation run. We will use the `fictional` library to ensure deterministic shuffling of the combined set.

### Findings
- `runSampleSimulationRunAction` in `simulation-actions.ts` handles the sampling logic but currently ignores manual `r2Keys` if triggered as a sample.
- `runPhaseR2Listing` in the simulation runner skips listing if `r2Keys` are prepopulated in the config.
- `fictional.someOf` can be used to shuffle the final combined list of keys before starting the run.

### Work Task Blueprint
<!-- Work Task Blueprint -->
#### Directory & File Structure
```text
src/app/
├── pages/audit/subpages/
│   ├── [MODIFY] simulation-actions.ts
│   └── [MODIFY] simulation-run-controls.tsx
```

#### Types & Data Structures
```typescript
// simulation-actions.ts
export async function runSampleSimulationRunAction(input: {
  // ...
  additionalR2Keys?: string[];
})
```

#### Invariants & Constraints
- **Determinism**: The combined set (manual + sampled) must be shuffled deterministically.
- **Priority**: Manual keys are always included.

#### System Flow (Snapshot Diff)
```diff
// simulation-actions.ts
- const finalKeys = picked;
+ const combined = Array.from(new Set([...additionalR2Keys, ...picked]));
+ const finalKeys = someOf(seed + ":final_shuffle", combined.length, combined);
```

#### Suggested Verification (Manual)
1. Enter manual keys in UI.
2. Configure sample size.
3. Click 'Run sample'.
4. Verify both manual and sampled keys are in the run and shuffled together.

### Tasks
- [ ] Update `runSampleSimulationRunAction` logic
- [ ] Update `SimulationRunControls` to pass manual keys
- [ ] Verify mixed sampling in UI

## [Implemented Mixed Sampling]
We successfully implemented the ability to merge manual R2 keys with sampled ones. The combined list is now deterministically shuffled using `fictional.someOf`.

### Changes
- Updated `runSampleSimulationRunAction` in `simulation-actions.ts` to accept `additionalR2Keys`, merge them with the sampled items, and shuffle the result.
- Updated `SimulationRunControls` to extract keys from the manual input area and pass them to the sample action.
- Updated `docs/blueprints/simulation-engine.md` to reflect the new behavior.


## PR Draft: Support Mixed Sampling in Simulations

### Problem
Previously, users had to choose between using a specific set of documents or a random sample for a simulation run. There was no way to do both, which made it difficult to test specific edge cases while also ensuring broad coverage.

### Solution
We updated the simulation sampling logic to allow merging manual R2 keys with a sampled set. When "Run sample" is clicked, any keys in the "Manual input" area are combined with the balanced sample. The final set is then deterministically shuffled using `fictional.someOf` (by picking all items) to ensure that manual documents are distributed throughout the run rather than being clustered at the beginning.

### Verification
The user verified the wiring and confirmed that the combined selection works as intended. We also updated the Simulation Engine architecture blueprint to reflect this new capability.

