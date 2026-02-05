# Fixing Discord Ingestion Failure [2026-02-04]

## Investigating 'No plugin could prepare document' in PRD
We are seeing a rash of ingestion failures for Discord documents (`.jsonl`) with the error: `No plugin could prepare document`. 
This indicates that the `ingest_diff` orchestrator is failing to find a plugin that claims ownership or successfully prepares the metadata for these Discord keys.

R2 Key Example: `discord/679514959968993311/1307974274145062912/2026-01-20.jsonl`

