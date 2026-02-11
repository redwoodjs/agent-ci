---
title: Implementing Secure On-demand GitHub Installation Tokens
date: 2026-02-11 15:35
author: peterp
---

# Implementing Secure On-demand GitHub Installation Tokens

## Summary
We successfully implemented a secure authentication flow for the Bridge to generate short-lived, job-scoped GitHub Installation Access Tokens (IAT). This replaces the use of a persistent `GITHUB_TOKEN`, significantly improving the security posture of the runner environment. We also extended the Digital Twin Unit (DTU) to simulate GitHub's token exchange API, ensuring a consistent code path across development and production.

## The Problem
The previous implementation relied on a persistent `GITHUB_TOKEN` passed from the Bridge to the Runner and then into the job container. This meant any compromised container could potentially leak a token with broad, long-lived access. The goal was to move to GitHub App authentication where tokens are generated on-demand and scoped to specific repositories.

## Investigation & Timeline
*   **Initial State:** The Bridge used `GITHUB_TOKEN` from environment variables. The Runner polled `/api/jobs` and received this token in the job specification.
*   **Attempts:**
    *   Researched the standard GitHub App flow: JWT signing (RSASSA-PKCS1-v1_5) -> Exchange for Installation Token.
    *   Verified that Cloudflare Workers support the Web Crypto API for these cryptographic operations.
    *   Researched how GitHub's own runners handle job-scoped tokens via `ACTIONS_RUNTIME_TOKEN`.
    *   Implemented a "Simulation Mode" in the Bridge to bypass crypto during dev, but later refined this to use a real dummy RSA key for better consistency.

## Discovery & Key Findings
*   **Web Crypto vs. node:crypto:** We used the Web Crypto API to ensure compatibility with the Cloudflare Worker runtime (Wrangler/workerd).
*   **DTU as a Mirror:** We found that the DTU mock server is the best place to handle environment-specific behavior, allowing the Bridge code to remain "pure" and environment-agnostic.
*   **Presence & Availability:** Polling `/api/jobs` not only retrieves work but also serves as a "presence" heartbeat for the Bridge.

## Resolution
The final solution involves:
1.  **DTU Mock**: Implemented `POST /app/installations/:id/access_tokens` in the DTU server.
2.  **Bridge `github.ts`**: A new utility using `crypto.subtle` to sign JWTs and fetch IATs.
3.  **Bridge Routes**: Updated `handleWebhook` to store `installationId` and `handleJobs` to generate tokens on-demand.
4.  **Local Dev**: Updated `.dev.vars` with a dummy RSA key and pointed `GITHUB_API_URL` to the DTU.

## Next Steps
- [ ] Refine Bridge-Runner protocol to return `{ username, jobs }`.
- [ ] Update Runner to validate its own presence via the Bridge response.
- [ ] Verify the full flow with the real Runner agent.
