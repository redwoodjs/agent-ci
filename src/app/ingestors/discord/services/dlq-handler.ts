import { updateBackfillState } from "./backfill-state";
import type { ProcessorJobMessage } from "./backfill-types";

export async function handleDeadLetterMessage(message: ProcessorJobMessage): Promise<void> {
  const { guild_channel_key } = message;
  
  console.error(
    `[dlq-handler] Message sent to DLQ for ${guild_channel_key}:`,
    JSON.stringify(message, null, 2)
  );

  await updateBackfillState(guild_channel_key, {
    status: "paused_on_error",
    error_message: "Processor job failed repeatedly and was sent to DLQ",
    error_details: JSON.stringify(message, null, 2),
  });

  console.log(`[dlq-handler] Updated backfill state to paused_on_error for ${guild_channel_key}`);
}


