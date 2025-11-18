import type { ProcessorJobMessage } from "./backfill-types";
import { processChannelEvent } from "./channel-processor";
import { processThreadEvent } from "./thread-processor";

export async function processProcessorJob(
  message: ProcessorJobMessage
): Promise<void> {
  const { guild_channel_key, guildID, channelID, entity_type, entity_id } = message;

  console.log(
    `[processor] Processing job: ${guild_channel_key}, entity_type: ${entity_type}, entity_id: ${entity_id || "N/A"}`
  );

  try {
    if (entity_type === "channel") {
      await processChannelEvent(guildID, channelID);
    } else if (entity_type === "thread") {
      if (!entity_id) {
        throw new Error("Thread entity_id is required for thread processing");
      }
      await processThreadEvent(guildID, channelID, entity_id);
    } else {
      throw new Error(`Unknown entity type: ${entity_type}`);
    }

    console.log(
      `[processor] Successfully processed ${entity_type} for ${guild_channel_key}`
    );
  } catch (error) {
    console.error(
      `[processor] Error processing ${entity_type} for ${guild_channel_key}:`,
      error
    );
    throw error;
  }
}


