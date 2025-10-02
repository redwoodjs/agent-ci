import { readFileSync, writeFileSync } from "fs";
import {
  discordJsonToMarkdown,
  generateMarkdownFilename,
} from "../app/services/discord-to-markdown";

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error(
      "Usage: tsx src/scripts/convert-discord-to-markdown.ts <input-json-file> [output-md-file]"
    );
    process.exit(1);
  }

  const inputFile = args[0];
  const outputFile = args[1];

  try {
    console.log(`Reading ${inputFile}...`);
    const jsonContent = readFileSync(inputFile, "utf-8");

    console.log("Converting to markdown...");
    const markdown = discordJsonToMarkdown(jsonContent);

    if (outputFile) {
      console.log(`Writing to ${outputFile}...`);
      writeFileSync(outputFile, markdown, "utf-8");
      console.log("Done!");
    } else {
      console.log("\n--- Markdown Output ---\n");
      console.log(markdown);
    }
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
