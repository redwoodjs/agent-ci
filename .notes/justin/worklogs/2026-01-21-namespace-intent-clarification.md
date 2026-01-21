## 2026-01-21 Clarification on Namespace Intent and Linking Fails

### Clarified Namespace Intent and Linking Failures

We investigated the root cause of `no_candidate` linking failures in simulation runs.

Logs from comprehensive runs confirmed that both Child (PR) and Parent (Issue) moments are correctly materialized within the simulation's isolated namespace (`local-...`). This validates the design intent that simulation runs should be self-contained and that "links never cross namespaces."

We found that the `deterministic_linking` runner currently infers the context namespace from the fetched child moment (`childRaw._namespace`). This inference is fragile; if ambiguous, it causes the resolver to default to the base namespace, failing to locate the parent which resides in the simulation shard.

We decided to refactor the simulation runners (`deterministic_linking`, `candidate_sets`, `timeline_fit`) to strict namespace enforcement. Instead of relying on inferred properties, we will explicitly configure the query context with the run's `effectiveNamespace`. This ensures distinct isolation and guarantees that resolvers search the correct shard for parent candidates.
