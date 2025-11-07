import { updateBackfillState } from "./backfill-state";
import type { ProcessorJobMessage } from "./backfill-types";

export async function handleDeadLetterMessage(message: ProcessorJobMessage): Promise<void> {
  const { repository_key } = message;

  console.error(`[dlq] Processing dead-letter message for ${repository_key}`);

  await updateBackfillState(repository_key, {
    status: "paused_on_error",
    error_message: "Processor job failed after all retries",
    error_details: JSON.stringify(message, null, 2),
  });
}

