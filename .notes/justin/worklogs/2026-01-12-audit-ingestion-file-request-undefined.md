# 2026-01-12-audit-ingestion-file-request-undefined

## Noticed audit ingestion file page errors in worker logs

The worker logs show a server-side exception for GET `/audit/ingestion/file/...`:

- ReferenceError: request is not defined

The URL includes namespace query params, so the failure prevents inspecting a specific ingested document from the audit UI.

## Plan

- Trace the `/audit/ingestion/file/*` route to the page component.
- Find the out-of-scope request reference and fix it to use the request passed into the route handler.
- Check for other missing variables in the page (moments, audit logs, link params), and either wire them up or remove the references so the page can render.

## Found out-of-scope request reference in ingestion file page

`/audit/ingestion/file/*` routes to the ingestion file page component.

That component was using `request.url` but did not take `request` as a prop, so it was referencing a variable that does not exist in module scope. This matches the worker error: ReferenceError: request is not defined.

## Wired ingestion file page to use request prop and load related data

Updated the ingestion file page to take the request prop and use it for query params.

Also wired the page to:

- compute the effective moment graph namespace (including prefix handling)
- list moments for the current document id
- load synthesis audit logs for the current document id

Typecheck was not run here (command got interrupted), but the file has no linter errors.
