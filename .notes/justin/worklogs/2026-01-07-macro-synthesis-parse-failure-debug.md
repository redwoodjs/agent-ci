# 2026-01-07 - Macro synthesis parse failure debug

## Problem

In the knowledge graph UI, some smart-linker candidate moments are titled `Summarized micro-moments` and have summary `Synthesized macro-moments could not be parsed.`.

These look like fallback moments created when macro synthesis output parsing fails, but they are being persisted and then show up in vector search and linking decisions.

## Plan

- Identify the exact code path that creates these placeholder macro moments.
- Trace how these moments get persisted and indexed for candidate search.
- Add a debug call (curl) for the existing debug endpoint to fetch the tree + audit log for the root in question.
- Decide whether to:
  - skip persistence for parse-failure output, or
  - persist with an explicit marker and ensure the smart linker and UI treat them as non-linkable noise.
- Build-check.

## Notes

- The placeholder strings come from the macro synthesis implementation, in the path that runs when zero macro moments are parsed from the model response.

## Findings

- The placeholder macro moment is created in the macro synthesis function when the model response does not match the expected format well enough for the regex parser to extract any macro moments.
- The placeholder moment has no importance score, so the downstream importance gate keeps it via its fallback behavior (keep one moment even when all are below the min-importance threshold).
- Once persisted, these moments are indexed into vector search and can show up as smart-linker candidates, which makes audit output confusing and can lead to incorrect linking.

## Decisions

- Do not persist a parse-failure placeholder macro moment. When macro synthesis fails to parse any macro moments, treat the stream as having produced zero macro moments.
- Add a filter so any remaining placeholder moments in the database are rejected as smart-linker candidates with an explicit reject reason.

## Implementation

- Changed macro synthesis parse failure behavior to return an empty list instead of generating a placeholder macro moment.
- Added a macro gating noise filter that drops parse-failure placeholder macro moments without fallback.
- Updated the smart-linker candidate evaluation to explicitly reject parse-failure placeholder moments when they appear in vector search results.

## Curl (debug endpoint)

Example for the root shown in the UI:

```sh
curl -fsS 'https://machinen.redwoodjs.workers.dev/admin/moment-debug' \
  -H "Authorization: Bearer ${MACHINEN_API_KEY}" \
  -H 'Content-Type: application/json' \
  --data '{
    "momentId": "0a85df65-83b2-4df2-94da-2d22407dc055",
    "momentGraphNamespacePrefix": "prod-2025-01-07-15-37",
    "includeTree": true,
    "treeMaxNodes": 5000,
    "includeCandidateMoments": true,
    "candidateLimit": 50
  }'
```

## PR Title: Stop persisting macro synthesis parse-failure placeholder moments

### Description

Some macro synthesis attempts fail to parse the model output into macro moments. The current fallback behavior generates a placeholder macro moment with title `Summarized micro-moments` and summary `Synthesized macro-moments could not be parsed.`.

These placeholders are then persisted and indexed, so they show up in smart-linker candidate lists and can be used in attachment decisions. This makes knowledge graph debugging harder and pollutes candidate search.

This change removes the placeholder persistence behavior by treating parse failures as producing zero macro moments for that stream. It also adds a filter so any existing placeholder moments found via vector search are explicitly rejected as smart-linker candidates with a dedicated reject reason.

## Follow-up: persist synthesis failures for audit UI + debug endpoint

The placeholder removal means parse failures no longer result in a macro moment being persisted, which is correct for graph quality but makes it harder to inspect the failure after the fact.

I added a document-level audit log table in the moment DB and wrote parse failure details there during indexing. The audit UI moment panel and `/admin/moment-debug` now include these records for the moment's document.

- Stored fields are intentionally small:
  - kind (namespaced as `synthesis:<kind>`)
  - message
  - prompt hash (first 16 chars of sha256)
  - response preview (first 2000 chars) and response length
