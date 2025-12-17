## Problem
I want a step-by-step timeline of how client navigation prefetching works in RedwoodSDK.

## Context
Need a short, concrete sequence that describes what triggers prefetching, what gets fetched, where it is cached, and how it is cancelled or deduped.

## Plan
- Use machinen_search to locate the RedwoodSDK client-side prefetch implementation.
- Trace the call chain for link hover/viewport prefetch and for navigation-driven prefetch.
- Summarize the runtime timeline and list key files/functions involved.
