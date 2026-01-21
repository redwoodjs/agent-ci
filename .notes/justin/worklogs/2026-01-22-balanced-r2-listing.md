# Balanced R2 Listing Discovery fix

// context(justinvdm, 2026-01-22): We identified a discovery imbalance in the `r2_listing` phase where the global `maxPages` limit allowed the first segment (GitHub) to consume the entire budget, excluding Discord and Cursor data.

## Plan
- [x] Balance R2 Listing Phase (Discovery)
    - [x] Implement per-prefix page limits in `r2_listing` runner
    - [x] Verify balanced discovery in logs

## Implemented per-prefix limits
We updated the `r2_listing` runner to track `prefixPagesProcessed` and enforce a per-prefix limit (`maxPages / prefixes.length`). This ensures that if we have a 100-page limit and 3 prefixes, each gets ~33 pages, preventing the first one from starving the others.
