#!/usr/bin/env node

import fs from "fs";

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:5173";

async function testDiscordParse(key) {
  try {
    console.log(`Testing Discord parse endpoint...`);
    console.log(`API: ${API_BASE_URL}/ingest/discord/parse`);
    console.log(`Key: ${key}\n`);

    const response = await fetch(`${API_BASE_URL}/ingest/discord/parse`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ key }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Error response:", response.status);
      console.error(JSON.stringify(data, null, 2));
      process.exit(1);
    }

    console.log("Success!");
    console.log(`Lines parsed: ${data.lines}`);
    console.log(`\nFirst 5 lines:\n`);
    data.transcript.slice(0, 5).forEach((line, i) => {
      console.log(`${i + 1}. ${line}`);
    });

    if (data.transcript.length > 5) {
      console.log(`\n... and ${data.transcript.length - 5} more lines`);
    }

    console.log(`\nFull response saved to: discord-parse-result.json`);
    fs.writeFileSync(
      "discord-parse-result.json",
      JSON.stringify(data, null, 2)
    );
  } catch (error) {
    console.error("Request failed:", error.message);
    process.exit(1);
  }
}

const key =
  process.argv[2] ||
  "discord/679514959968993311/1307974274145062912/2024-11-18.jsonl";

testDiscordParse(key);
