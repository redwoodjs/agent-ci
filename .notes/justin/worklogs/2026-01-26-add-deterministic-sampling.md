# 2026-01-26-add-deterministic-sampling

## Context
The user requested that "sample running" be made deterministic using a seed.
Currently, `runSampleSimulationRunAction` in `src/app/pages/audit/subpages/simulation-actions.ts` uses `Math.random()` for shuffling keys, which is non-deterministic.
The user suggested using the `fictional` library.

## Work Task Blueprint: Deterministic Sampling

### Goal
Make "Run Sample" deterministic by introducing a seed and using `fictional` for selection.

### Directory & File Structure
```text
/
├── [MODIFY] package.json
└── src/app/pages/audit/subpages/
    ├── [MODIFY] simulation-actions.ts
    └── [MODIFY] simulation-run-controls.tsx
```

### Types & Data Structures
```typescript
// src/app/pages/audit/subpages/simulation-actions.ts

export async function runSampleSimulationRunAction(input: {
  r2Prefix: string;
  githubRepo?: string;
  limitPerPage: number;
  maxPages: number;
  sampleSize: number;
  momentGraphNamespace: string | null;
  momentGraphNamespacePrefix: string | null;
  seed?: string; // NEW: Optional seed for deterministic sampling
})
```

### Invariants & Constraints
*   **Determinism**: Given the same R2 keys and the same seed, `runSampleSimulationRunAction` must return the same subset of keys.
*   **Backward Compatibility**: If no seed is provided, the system should generate one (e.g., using `crypto.randomUUID()`) to ensure the run itself is reproducible if restarted, but the initial selection remains "random" (seeded by the new UUID).
*   **Constraint**: Use the `fictional` library as requested by the user for seeded randomness.

### System Flow (Snapshot Diff)
**Previous Flow**:
1. UI triggers `runSampleSimulationRunAction`.
2. Action lists keys from R2.
3. Action shuffles keys using `Math.random()`.
4. Action takes `sampleSize` keys and creates Simulation Run.

**New Flow**:
1. UI triggers `runSampleSimulationRunAction` (optionally passing a `seed`).
2. Action lists keys from R2.
3. Action initializes `fictional` with `seed`.
4. Action shuffles keys using a seeded shuffle (via `fictional`).
5. Action takes `sampleSize` keys and creates Simulation Run (storing `seed` in `config`).

### Natural Language Context
Using `Math.random()` makes it impossible to reproduce the exact same sample in a new run. By introducing a seed, we can ensure that "Run Sample" is deterministic. We use `fictional` because it provides a clean API for seeded generation and was specifically requested.

### Suggested Verification (Manual)
1. **Initial Run**: Click "Run Sample" in the UI. Note the "Seed" used (if exposed) or find it in the `simulation_runs` table `config_json`.
2. **Reproduce**: Run again with the *same* seed (via custom trigger or API). Verify the `r2Keys` in `simulation_runs` are identical.
3. **Change**: Run with a *different* seed. Verify the keys are different.
