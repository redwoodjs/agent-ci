#!/usr/bin/env node

/**
 * Query the SUBJECT_INDEX Vectorize index directly
 *
 * Usage:
 *   ./scripts/query-subject-index.mjs "your search query here"
 *   node scripts/query-subject-index.mjs "your search query here"
 *
 * Environment variables:
 *   CLOUDFLARE_ENV - Optional (defaults to "dev-justin")
 *   API_KEY - Required for authentication
 */

import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

// Load .dev.vars if it exists
function loadEnvVars() {
  try {
    const envPath = join(PROJECT_ROOT, ".dev.vars");
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, "utf-8");
      content.split("\n").forEach((line) => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          const [key, ...valueParts] = trimmed.split("=");
          const value = valueParts.join("=").trim();
          if (key && value) {
            process.env[key.trim()] = value;
          }
        }
      });
    }
  } catch (error) {
    // Ignore errors loading .dev.vars
  }
}

loadEnvVars();

const CLOUDFLARE_ENV = process.env.CLOUDFLARE_ENV || "dev-justin";
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.error("Error: API_KEY environment variable is required");
  process.exit(1);
}

// Determine worker URL based on environment
function getWorkerUrl() {
  if (process.env.WORKER_URL) {
    return process.env.WORKER_URL;
  }

  const envMap = {
    "dev-justin": "https://machinen-dev-justin.redwoodjs.workers.dev",
    production: "https://machinen.redwoodjs.workers.dev",
  };

  return envMap[CLOUDFLARE_ENV] || envMap["dev-justin"];
}

const WORKER_URL = getWorkerUrl();

async function querySubjectIndex(searchText) {
  console.log(`\n🔍 Querying SUBJECT_INDEX for: "${searchText}"`);
  console.log(`📍 Environment: ${CLOUDFLARE_ENV}`);
  console.log(`🌐 Worker URL: ${WORKER_URL}\n`);

  try {
    const response = await fetch(`${WORKER_URL}/rag/debug/query-subject-index`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": API_KEY,
      },
      body: JSON.stringify({
        query: searchText,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `HTTP ${response.status}: ${errorText || response.statusText}`
      );
    }

    const result = await response.json();
    return result;
  } catch (error) {
    console.error("❌ Error querying index:", error.message);
    throw error;
  }
}

// Main execution
const searchQuery = process.argv[2];

if (!searchQuery) {
  console.error("Error: Please provide a search query as an argument");
  console.error("\nUsage:");
  console.error('  ./scripts/query-subject-index.mjs "your search query"');
  process.exit(1);
}

querySubjectIndex(searchQuery)
  .then((result) => {
    console.log("\n📊 Query Results:\n");
    console.log(`Found ${result.matches?.length || 0} matches\n`);

    if (result.matches && result.matches.length > 0) {
      result.matches.forEach((match, index) => {
        console.log(`${index + 1}. Subject ID: ${match.id}`);
        console.log(`   Score: ${match.score.toFixed(4)}`);
        console.log(`   Title: ${match.metadata?.title || "N/A"}`);
        console.log("");
      });
    } else {
      console.log("No matches found.");
    }

    if (result.debug) {
      console.log("\n🔧 Debug Info:");
      console.log(JSON.stringify(result.debug, null, 2));
    }
  })
  .catch((error) => {
    console.error("\n❌ Failed to query index:", error.message);
    process.exit(1);
  });

