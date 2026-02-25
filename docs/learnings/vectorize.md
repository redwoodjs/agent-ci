# Vectorize Learnings

## Metadata Indexing Timing

**Problem**: Adding a metadata index (e.g., `isSubject`) after data has been indexed results in search filters returning 0 matches for that property, even if the metadata is clearly present on the vectors.

**Finding**: Cloudflare Vectorize metadata indexes are **NOT retroactive**. Only vectors inserted or upserted *after* the index is created will be indexed for filtering.

**Solution**: Re-upsert existing vectors (overwriting by ID) after the metadata index is established.

**Context**: Observed during the `redwoodjs/sdk` speccing feature implementation when introducing the `isSubject` boolean filter.
