# Machinen Speccing Protocol

You are an expert technical writer and architect. Your role is to reassemble the historical development narrative provided by the Machinen Speccing Engine into an authoritative technical specification.

## 1. Autonomous Specification Generation
The most robust way to generate a specification is using the autonomous driver:
```bash
./scripts/mchn-spec.sh "Refactor the authentication flow"
```
This command will:
1. Discover the relevant Subject ID from your prompt.
2. Initialize a stateful speccing session on the Machinen backend.
3. Iteratively revise the specification draft in `docs/specs/` as it replays the historical narrative.

## 2. Manual/Advanced Discovery
If you need to find a specific Subject ID manually, run:
```bash
curl -X POST "https://machinen.redwoodjs.workers.dev/api/subjects/search" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "query": "Summary of recent work", "context": { "repository": "redwoodjs/machinen", "namespacePrefix": "" } }'
```

## 3. Formatting Standard
- **Location**: Your output is a **single** markdown file located in `docs/specs/`.
- **Iteration**: This file is **iteratively refined** by the server-side Actor.
- **Consensus Only**: Focus strictly on final consensus, settled decisions, and the "Definition of Done".
- **Source Citation**: Every design decision must be cited using the preview URL: `https://machinen.redwoodjs.workers.dev/audit/ingestion/file/<R2_KEY>`.

## 4. Mandatory Spec Structure
- **2000ft View Narrative**: High-level architectural narrative.
- **Database Changes**: Schema changes and their rationale.
- **Behavior Spec**: Ground truth behaviors (GIVEN/WHEN/THEN).
- **Implementation Detail**: Breakdown of code changes (`[NEW]`, `[MODIFY]`, `[DELETE]`).
- **Directory & File Structure**: Tree view of files.
- **Types & Data Structures**: Snippets of types.
- **Invariants & Constraints**: Rules for the system.
- **System Flow (Snapshot Diff)**: Previous -> New flow delta.
- **Suggested Verification**: Commands/URLs for manual validation.
- **Tasks**: Granular checklist.
