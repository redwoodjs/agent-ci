# Learning: Cloudflare AI InferenceUpstreamError (1031)

## Problem
When running the Machinen Engine locally (`pnpm dev`), calls to Vectorize or AI embedding generation fail with `InferenceUpstreamError: error code: 1031`.

## Finding
This error code is misleading. While "Upstream Error" suggests a Cloudflare-side issue, in the local development environment, it often indicates **missing authentication credentials** for the Cloudflare AI binding. The local worker needs explicit account credentials to authorize requests to the AI inference API.

## Solution
Restart the development server with the following environment variables exported:

```bash
export CLOUDFLARE_ACCOUNT_ID='<your_account_id>'
export CLOUDFLARE_API_TOKEN='<your_api_token>'
pnpm dev
```

**Do not attempt to implement retry logic or SQL fallbacks for this error.** It is a configuration issue, not a transient failure.
