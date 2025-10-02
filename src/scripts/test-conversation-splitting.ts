import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import {
  splitDiscordConversations,
  processDiscordExport,
} from "../app/services/conversation-splitter";

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error(
      "Usage: tsx src/scripts/test-conversation-splitting.ts <input-json-file> [output-dir]"
    );
    process.exit(1);
  }

  const inputFile = args[0];
  const outputDir = args[1] || "./conversation-splits";

  try {
    console.log(`Reading ${inputFile}...`);
    const jsonContent = readFileSync(inputFile, "utf-8");
    const messages = JSON.parse(jsonContent);

    console.log(`Processing ${messages.length} messages...`);

    // Extract channel and guild info from filename or metadata
    const channelId = "1307974274145062912"; // From your example
    const guildId = "679514959968993311"; // From your example
    const sourceId = 1; // Mock source ID

    // Split conversations
    const splits = splitDiscordConversations(messages);
    console.log(`Created ${splits.length} conversation splits`);

    // Create artifacts
    const artifacts = await processDiscordExport(
      messages,
      sourceId,
      channelId,
      guildId
    );

    // Create output directory
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    // Write split summaries
    const summary = {
      totalMessages: messages.length,
      totalSplits: splits.length,
      splits: splits.map((split) => ({
        id: split.id,
        startTime: split.startTime,
        endTime: split.endTime,
        messageCount: split.messageCount,
        participantCount: split.participantCount,
        threadCount: split.threadCount,
        participants: split.participants,
        splitType: split.splitType,
      })),
    };

    writeFileSync(
      `${outputDir}/conversation-summary.json`,
      JSON.stringify(summary, null, 2),
      "utf-8"
    );

      // Write individual conversation artifacts
      for (let i = 0; i < artifacts.length; i++) {
        const artifact = artifacts[i];
        const filename = `conversation-${
          artifact.metadata.timeSpan.start.split("T")[0]
        }-${String(i + 1).padStart(2, "0")}.md`;

      writeFileSync(
        `${outputDir}/${filename}`,
        `# ${artifact.title}\n\n${artifact.content}`,
        "utf-8"
      );
    }

    console.log(`\nConversation splitting complete!`);
    console.log(`- Total messages: ${messages.length}`);
    console.log(`- Conversation splits: ${splits.length}`);
    console.log(`- Output directory: ${outputDir}`);
    console.log(`\nSplit details:`);

    splits.forEach((split, index) => {
      const startDate = new Date(split.startTime).toISOString().split("T")[0];
      const endDate = new Date(split.endTime).toISOString().split("T")[0];
      console.log(
        `  ${index + 1}. ${startDate} → ${endDate} (${
          split.messageCount
        } messages, ${split.participantCount} participants, ${
          split.threadCount
        } threads)`
      );
    });
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
