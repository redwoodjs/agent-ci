import fs from "node:fs";
import readline from "node:readline";
import type { JsonlMessage } from "./types.js";

export type ReadResult = {
  messages: JsonlMessage[];
  linesRead: number;
};

// Read a JSONL file starting at lineOffset, returning only user/assistant records.
// linesRead reflects the total line count from the start of the file (not just new lines),
// so it can be stored directly as the next lastLineOffset.
export async function readFromOffset(jsonlPath: string, lineOffset: number): Promise<ReadResult> {
  const messages: JsonlMessage[] = [];
  let lineIndex = 0;

  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(jsonlPath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", (line) => {
      const current = lineIndex;
      lineIndex++;

      if (current < lineOffset) {
        return;
      }
      if (!line.trim()) {
        return;
      }

      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }

      const type = record["type"];
      if (type !== "user" && type !== "assistant") {
        return;
      }

      messages.push(record as unknown as JsonlMessage);
    });

    rl.on("close", () => resolve({ messages, linesRead: lineIndex }));
    rl.on("error", reject);
    stream.on("error", reject);
  });
}

// Tags injected by the system (IDE, Claude Code) that carry no spec-relevant
// information. Matched with dotAll so tags spanning multiple lines are stripped.
const SYSTEM_TAG_PATTERNS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g,
  /<ide_selection>[\s\S]*?<\/ide_selection>/g,
];

function stripSystemTags(text: string): string {
  let result = text;
  for (const pattern of SYSTEM_TAG_PATTERNS) {
    result = result.replace(pattern, "");
  }
  return result;
}

// Extract plain text from a message's content blocks.
// content may be a plain string (older/simple messages) or a blocks array.
export function extractText(message: JsonlMessage): string {
  const { content } = message.message;
  if (typeof content === "string") {
    return stripSystemTags(content).trim();
  }
  if (!Array.isArray(content)) {
    console.warn(
      `[reader] unexpected content type: ${typeof content} on ${message.type} message in session ${message.sessionId}`,
      content,
    );
    return "";
  }
  return stripSystemTags(
    content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n"),
  ).trim();
}
