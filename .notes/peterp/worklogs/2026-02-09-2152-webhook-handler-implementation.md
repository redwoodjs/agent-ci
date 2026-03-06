---
title: Webhook Handler Implementation
date: 2026-02-09 21:52
author: peterp
---

# Webhook Handler Implementation

## Summary

Implemented the GitHub webhook handler in `machinen-bridge`, refactored secrets management, and aligned KV bindings with the project's naming conventions.

## The Problem

We needed to implement a webhook handler to receive events from GitHub, but the existing codebase was just scaffolding. We also needed to ensure secure secret management and proper KV namespace usage.

## Investigation & Timeline

- **Initial State:** `machinen-bridge` had basic routing but no actual webhook logic. Secrets were manually handled.
- **Attempts:**
  - Refactored `secrets.ts` to use Zod for environment variable validation.
  - Renamed KV bindings in `wrangler.jsonc` to `MACHINEN_BRIDGE_JOBS` and `MACHINEN_BRIDGE_PRESENCE`.
  - Implemented `handleWebhook` in `src/api/routes.ts` with signature verification, deduplication, and job queuing.
  - Created `scripts/test-webhook.ts` to verify the implementation.
  - Improved error messages in `secrets.ts` to explicitly mention missing `process.env` variables.

## Discovery & Key Findings

- The RedwoodSDK router pattern works well for this use case.
- Using `crypto.subtle` for signature verification requires careful type handling (e.g., casting `Uint8Array` to `any` or `BufferSource` to satisfy TS in the worker environment).
- Zod provides a clean way to validate environment variables at runtime.

## Resolution

We delivered a functional webhook handler that queues jobs to KV and verifies GitHub signatures. The configuration is now type-safe and validated on startup.

## Next Steps

- [ ] Implement the Runner side to poll for these queued jobs.
- [ ] Add end-to-end tests with the actual Runner.
- [ ] Deploy to Cloudflare and test with real GitHub webhooks.
