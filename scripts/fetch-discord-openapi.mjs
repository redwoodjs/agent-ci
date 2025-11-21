#!/usr/bin/env node

import { writeFile, mkdir, access } from "fs/promises";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const OPENAPI_URL =
  process.env.DISCORD_OPENAPI_URL ||
  "https://raw.githubusercontent.com/discord/discord-api-spec/main/specs/openapi/openapi.json";
const OUTPUT_PATH = new URL(
  "../src/app/ingestors/discord/openapi.json",
  import.meta.url
);
const outputPathStr = fileURLToPath(OUTPUT_PATH);

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function fetchOpenAPISpec() {
  try {
    console.log(`Fetching Discord OpenAPI spec from ${OPENAPI_URL}...`);
    const response = await fetch(OPENAPI_URL);

    if (!response.ok) {
      const exists = await fileExists(outputPathStr);
      if (exists) {
        console.log(
          `⚠ Fetch failed (${response.status}), but local file exists. Using local file.`
        );
        console.log(
          `  To update manually, download from Discord's API docs or set DISCORD_OPENAPI_URL`
        );
        return true;
      }
      console.warn(
        `⚠ Failed to fetch OpenAPI spec: ${response.status} ${response.statusText}`
      );
      return true; // Don't fail the build, just warn
    }

    const spec = await response.json();

    await mkdir(dirname(outputPathStr), { recursive: true });
    await writeFile(outputPathStr, JSON.stringify(spec, null, 2));

    console.log(`✓ OpenAPI spec saved to ${outputPathStr}`);
    return true;
  } catch (error) {
    const exists = await fileExists(outputPathStr);
    if (exists) {
      console.log(`⚠ Fetch error: ${error.message}`);
      console.log(`  Local file exists, continuing with local file.`);
      return true;
    }
    console.warn(`⚠ Error fetching OpenAPI spec: ${error.message}`);
    console.warn(
      `  Set DISCORD_OPENAPI_URL environment variable to use a different URL`
    );
    console.warn(`  Or manually download the spec to ${outputPathStr}`);
    return true; // Don't fail the build, just warn
  }
}

fetchOpenAPISpec().then((success) => {
  process.exit(success ? 0 : 1);
});
