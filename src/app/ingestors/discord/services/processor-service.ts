import type { ProcessorJobMessage } from "./backfill-types";
import { processChannelEvent } from "./channel-processor";
import { processThreadEvent } from "./thread-processor";
import { incrementBackfillProcessedCountAndMaybeComplete } from "./backfill-state";

export async function processProcessorJob(
  message: ProcessorJobMessage
): Promise<void> {
  const { guild_channel_key, guildID, channelID, entity_type, entity_id } =
    message;
  const backfillRunId = message.backfill_run_id ?? null;
  const isBackfill = message.event_type === "backfill";
  const momentGraphNamespacePrefix =
    message.moment_graph_namespace_prefix ?? null;

  console.log(
    `[processor] Processing job: ${guild_channel_key}, entity_type: ${entity_type}, entity_id: ${
      entity_id || "N/A"
    } (event: ${message.event_type}${
      isBackfill && backfillRunId ? ` runId=${backfillRunId}` : ""
    }${
      isBackfill && momentGraphNamespacePrefix
        ? ` prefix=${momentGraphNamespacePrefix}`
        : ""
    })`
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

    if (isBackfill && backfillRunId) {
      const completion = await incrementBackfillProcessedCountAndMaybeComplete(
        guild_channel_key,
        backfillRunId
      );
      if (completion?.shouldLogCompletion) {
        console.log("[backfill] processed completed", {
          guildChannelKey: guild_channel_key,
          backfillRunId,
          momentGraphNamespacePrefix: completion.momentGraphNamespacePrefix,
          processedCount: completion.processedCount,
          enqueuedCount: completion.enqueuedCount,
        });
      }
    }
  } catch (error) {
    console.error(
      `[processor] Error processing ${entity_type} for ${guild_channel_key}:`,
      error
    );
    throw error;
  }
}
