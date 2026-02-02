import { Phase, PipelineContext } from "../../engine/runtime/types";
import { runIngestDiffForKey } from "./engine/core/orchestrator";

/**
 * Ingest Diff Phase
 * 
 * Input: r2Key (string)
 * Logic: Checks if the document at r2Key has changed since last indexing.
 * Output: 
 *   - { etag: string, changed: true } -> Proceed to next phase
 *   - null -> Stop (Document has not changed)
 */
export const IngestDiffPhase: Phase<string, { etag: string; changed: boolean } | null> = {
  name: "ingest_diff",
  next: "micro_batches",
  execute: async (r2Key: string, context: PipelineContext) => {
    const result = await runIngestDiffForKey({ r2Key, context });
    
    if (!result.changed) {
      return null;
    }
    
    return result;
  },
};
