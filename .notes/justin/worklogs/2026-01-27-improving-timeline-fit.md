# Improving Timeline Fit 2026-01-27

## Initiated investigation into timeline fit failures
We are investigating why "timeline fit" practically always returns 0 candidates. We suspect it might be broken at the candidate selection phase, preventing the system from even deciding on a fit. We also need to prepare for a simulation run with specific "needle" candidates.

**Context:**
- Related to issue 552 and PR 933.
- Focus on RSC requests, pre-fetching, and caching.
- Need to extract/derive documents for a "haystack" (25-50 sample) and include "needles" (known links).
- Discord conversation provided clues about client-side navigation and RSC GET requests.
