#!/usr/bin/env node

/**
 * Manually select and index a file for RAG
 *
 * Usage:
 *   ./scripts/manual-index.mjs [prefix] [--threads|--days]
 *   node scripts/manual-index.mjs [prefix] [--threads|--days]
 *
 * Options:
 *   --threads    Show only Discord thread files (latest.json in threads/)
 *   --days       Show only Discord daily channel messages (.jsonl files)
 *
 * Environment variables:
 *   API_KEY - Required for authentication
 *   CLOUDFLARE_ENV - Optional (determines worker URL, e.g., "dev-justin", "production")
 *   R2_ACCOUNT_ID - Optional (reads from rclone config if not set)
 *   R2_ACCESS_KEY_ID - Optional (reads from rclone config if not set)
 *   R2_SECRET_ACCESS_KEY - Optional (reads from rclone config if not set)
 *   R2_BUCKET_NAME - Optional (defaults to "machinen")
 *   WORKER_URL - Optional (overrides CLOUDFLARE_ENV-based URL if set)
 *
 * Note: If R2 credentials aren't set in environment variables,
 * this script will attempt to read them from your rclone config (~/.config/rclone/rclone.conf)
 */

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { homedir } from "os";
import readline from "readline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

// Load .dev.vars if it exists
function loadEnvVars() {
  try {
    const envPath = join(PROJECT_ROOT, ".dev.vars");
    const content = readFileSync(envPath, "utf-8");
    content.split("\n").forEach((line) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const [key, ...valueParts] = trimmed.split("=");
        if (key && valueParts.length > 0) {
          const value = valueParts.join("=").replace(/^["']|["']$/g, "");
          if (!process.env[key]) {
            process.env[key] = value;
          }
        }
      }
    });
  } catch (error) {
    // .dev.vars doesn't exist, that's okay
  }
}

// Read rclone config
function loadRcloneConfig() {
  const configPath = join(homedir(), ".config", "rclone", "rclone.conf");

  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const content = readFileSync(configPath, "utf-8");
    const lines = content.split("\n");
    let inR2Section = false;
    const config = {};

    for (const line of lines) {
      const trimmed = line.trim();

      // Check for [r2] section
      if (trimmed === "[r2]") {
        inR2Section = true;
        continue;
      }

      // Check for new section (end of r2 section)
      if (trimmed.startsWith("[") && trimmed !== "[r2]") {
        inR2Section = false;
        continue;
      }

      // Parse key-value pairs in r2 section
      if (inR2Section && trimmed && !trimmed.startsWith("#")) {
        const [key, ...valueParts] = trimmed.split("=");
        if (key && valueParts.length > 0) {
          const value = valueParts.join("=").trim();
          config[key.trim()] = value;
        }
      }
    }

    // Extract account ID from endpoint
    if (config.endpoint) {
      const match = config.endpoint.match(
        /https:\/\/([^.]+)\.r2\.cloudflarestorage\.com/
      );
      if (match) {
        config.account_id = match[1];
      }
    }

    return config;
  } catch (error) {
    console.error("Warning: Could not read rclone config:", error.message);
    return null;
  }
}

loadEnvVars();

// Try to load from rclone config if not in env
const rcloneConfig = loadRcloneConfig();

// Parse command line arguments
let PREFIX = "";
let FILTER_TYPE = null; // null, 'threads', or 'days'

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--threads") {
    FILTER_TYPE = "threads";
  } else if (arg === "--days") {
    FILTER_TYPE = "days";
  } else if (!arg.startsWith("--")) {
    PREFIX = arg;
  }
}

const API_KEY = process.env.API_KEY;
const R2_ACCOUNT_ID =
  process.env.R2_ACCOUNT_ID || rcloneConfig?.account_id || null;
const R2_ACCESS_KEY_ID =
  process.env.R2_ACCESS_KEY_ID || rcloneConfig?.access_key_id || null;
const R2_SECRET_ACCESS_KEY =
  process.env.R2_SECRET_ACCESS_KEY || rcloneConfig?.secret_access_key || null;
const BUCKET_NAME = process.env.R2_BUCKET_NAME || "machinen";

// Determine worker URL from CLOUDFLARE_ENV, unless WORKER_URL is explicitly set
const CLOUDFLARE_ENV = process.env.CLOUDFLARE_ENV;
let WORKER_URL = process.env.WORKER_URL;

if (!WORKER_URL) {
  if (CLOUDFLARE_ENV === "production") {
    WORKER_URL = "https://machinen.redwoodjs.workers.dev";
  } else if (CLOUDFLARE_ENV && CLOUDFLARE_ENV.startsWith("dev-")) {
    // dev-justin -> machinen-dev-justin.redwoodjs.workers.dev
    const envName = CLOUDFLARE_ENV.replace("dev-", "");
    WORKER_URL = `https://machinen-dev-${envName}.redwoodjs.workers.dev`;
  } else {
    // Default to production if CLOUDFLARE_ENV is not set or unrecognized
    WORKER_URL = "https://machinen.redwoodjs.workers.dev";
  }
}

// Validation
if (!API_KEY) {
  console.error("Error: API_KEY is required");
  console.error("Set it in .dev.vars or as an environment variable");
  process.exit(1);
}

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
  console.error("Error: R2 credentials are required");
  console.error("");

  if (rcloneConfig) {
    console.error("Found rclone config but missing required fields.");
    console.error("Make sure your rclone 'r2' remote is properly configured.");
  } else {
    console.error(
      "Could not find rclone config at ~/.config/rclone/rclone.conf"
    );
  }

  console.error("");
  console.error("Set these in .dev.vars or as environment variables:");
  console.error("  R2_ACCOUNT_ID");
  console.error("  R2_ACCESS_KEY_ID");
  console.error("  R2_SECRET_ACCESS_KEY");
  console.error("");
  console.error("Or configure rclone with: ./scripts/setup-r2-rclone.sh");
  process.exit(1);
}

// Show where credentials came from
if (rcloneConfig && !process.env.R2_ACCOUNT_ID) {
  console.log("📝 Using R2 credentials from rclone config");
  console.log("");
}

// Show which environment/worker URL is being used
if (CLOUDFLARE_ENV) {
  console.log(`🌍 Using environment: ${CLOUDFLARE_ENV} (${WORKER_URL})`);
} else {
  console.log(`🌍 Using default worker: ${WORKER_URL}`);
}
console.log("");

// Create S3 client configured for R2
const s3Client = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

// Check if a file matches the filter
function matchesFilter(key, filterType) {
  if (!filterType) return true;

  const isDiscordFile = key.startsWith("discord/");
  if (!isDiscordFile) return true; // Don't filter non-discord files

  if (filterType === "threads") {
    // Thread files: discord/{guild}/{channel}/threads/{threadID}/latest.json
    return key.includes("/threads/") && key.endsWith("latest.json");
  } else if (filterType === "days") {
    // Daily files: discord/{guild}/{channel}/YYYY-MM-DD.jsonl
    return key.endsWith(".jsonl") && !key.includes("/threads/");
  }

  return true;
}

// Extract title from Cursor conversation
function extractCursorTitle(data) {
  try {
    if (!data.generations || data.generations.length === 0) {
      return `Conversation ${data.id || "unknown"}`;
    }

    // Find first user prompt
    for (const gen of data.generations) {
      const userPrompt = gen.events?.find(
        (e) => e.hook_event_name === "beforeSubmitPrompt" && e.prompt
      )?.prompt;
      if (userPrompt && userPrompt.trim()) {
        // Truncate to 60 chars for display
        const truncated = userPrompt.trim().substring(0, 60);
        return truncated + (userPrompt.length > 60 ? "..." : "");
      }
    }

    return `Conversation ${data.id || "unknown"} (${
      data.generations.length
    } turns)`;
  } catch (error) {
    return "Error extracting title";
  }
}

// Fetch and parse a Cursor conversation file
async function fetchCursorTitle(key) {
  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    });

    const response = await s3Client.send(command);
    const text = await response.Body.transformToString();
    const data = JSON.parse(text);
    return extractCursorTitle(data);
  } catch (error) {
    return null; // Return null on error, we'll fall back to key
  }
}

// Fetch latest files from R2
async function fetchLatestFiles(prefix, filterType) {
  console.log("Fetching latest files from R2 bucket...");
  if (prefix) {
    console.log(`Prefix: ${prefix}`);
  }
  if (filterType) {
    console.log(
      `Filter: ${
        filterType === "threads"
          ? "Discord threads only"
          : "Discord daily messages only"
      }`
    );
  }
  console.log("");

  try {
    const command = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: prefix || undefined,
      MaxKeys: 1000,
    });

    const response = await s3Client.send(command);

    if (!response.Contents || response.Contents.length === 0) {
      return [];
    }

    // Convert to our format, filter, and sort by last modified (newest first)
    let files = response.Contents.map((obj) => ({
      key: obj.Key,
      size: obj.Size || 0,
      lastModified: obj.LastModified || new Date(),
      title: null, // Will be populated for cursor conversations
    }))
      .filter((file) => matchesFilter(file.key, filterType))
      .sort((a, b) => b.lastModified - a.lastModified)
      .slice(0, 10);

    // Fetch titles for Cursor conversations
    console.log("Fetching conversation titles...");
    const isCursorPrefix = prefix && prefix.startsWith("cursor/conversations/");
    if (isCursorPrefix) {
      for (const file of files) {
        const title = await fetchCursorTitle(file.key);
        if (title) {
          file.title = title;
        }
      }
    }

    return files;
  } catch (error) {
    console.error("Error fetching files from R2:", error.message);
    if (error.name === "CredentialsProviderError") {
      console.error(
        "\nPlease check your R2 credentials in .dev.vars or environment variables"
      );
    }
    process.exit(1);
  }
}

// Format file size
function formatSize(bytes) {
  if (bytes >= 1048576) {
    return `${(bytes / 1048576).toFixed(2)}M`;
  } else if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(2)}K`;
  } else {
    return `${bytes}B`;
  }
}

// Format date
function formatDate(date) {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

// Display files and get selection
async function selectFile(files) {
  console.log("Select a file to index for RAG:");
  console.log("");

  files.forEach((file, index) => {
    const num = String(index + 1).padStart(2, " ");
    const datetime = formatDate(file.lastModified);
    const size = formatSize(file.size);

    if (file.title) {
      // Show title for Cursor conversations
      const title = file.title.padEnd(70, " ");
      console.log(`${num}) ${title}  ${datetime}  ${size}`);
      // Show key on next line indented
      console.log(`    ${file.key}`);
    } else {
      // Show key for other files
      const key = file.key.padEnd(70, " ");
    console.log(`${num}) ${key}  ${datetime}  ${size}`);
    }
  });

  console.log("");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(
      `Enter selection (1-${files.length}) or 'q' to quit: `,
      (answer) => {
        rl.close();

        if (answer.toLowerCase() === "q") {
          console.log("Cancelled");
          process.exit(0);
        }

        const selection = parseInt(answer, 10);
        if (isNaN(selection) || selection < 1 || selection > files.length) {
          console.error("Error: Invalid selection");
          process.exit(1);
        }

        resolve(files[selection - 1]);
      }
    );
  });
}

// Index the selected file
async function indexFile(r2Key) {
  console.log("");
  console.log(`Indexing: ${r2Key}`);
  console.log("");

  try {
    const response = await fetch(`${WORKER_URL}/admin/index`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ r2Key }),
    });

    const data = await response.json();

    if (data.success) {
      console.log("✓ File enqueued for indexing successfully");
      console.log("");
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.error("✗ Failed to enqueue file for indexing");
      console.error("");
      console.error(JSON.stringify(data, null, 2));
      process.exit(1);
    }
  } catch (error) {
    console.error("✗ Failed to enqueue file for indexing");
    console.error("");
    console.error("Error:", error.message);
    process.exit(1);
  }
}

// Main execution
async function main() {
  const files = await fetchLatestFiles(PREFIX, FILTER_TYPE);

  if (files.length === 0) {
    console.log("No files found matching the specified criteria");
    if (FILTER_TYPE) {
      console.log(
        `Tip: Try without the --${FILTER_TYPE} filter to see all files`
      );
    }
    process.exit(1);
  }

  const selectedFile = await selectFile(files);
  await indexFile(selectedFile.key);
}

main().catch((error) => {
  console.error("Unexpected error:", error);
  process.exit(1);
});
