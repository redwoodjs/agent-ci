#!/usr/bin/env tsx

/**
 * Machinen Speccing Engine - Autonomous Driver (TypeScript Edition)
 * Refactored from Bash for better resilience, streaming, and retry handling.
 * 
 * Usage: tsx scripts/mchn-spec.ts "prompt"
 */

import { execSync } from 'node:child_process';
import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';

// --- Configuration & Environment ---

const RAW_WORKER_URL = process.env.MACHINEN_ENGINE_URL || "https://machinen.redwoodjs.workers.dev";
const WORKER_URL = RAW_WORKER_URL.replace(/\/$/, "");
const API_KEY = process.env.API_KEY;
const NAMESPACE_PREFIX = process.env.NAMESPACE_PREFIX;

if (!API_KEY) {
  console.error("Error: API_KEY environment variable not set.");
  process.exit(1);
}

const PROMPT = process.argv[2];
if (!PROMPT) {
  console.error("Usage: tsx scripts/mchn-spec.ts \"<PROMPT>\" [--mode server|client]");
  process.exit(1);
}

// Simple mode detection
const REVISION_MODE = process.argv.includes('client') ? 'client' : 'server';

// --- Helpers ---

function getRepositoryContext(): string {
  try {
    const origin = execSync('git remote -v', { encoding: 'utf-8' });
    const match = origin.match(/origin.*github\.com[:\/](.*)\.git/);
    if (match && match[1]) return match[1];
    return basename(process.cwd());
  } catch (e) {
    return basename(process.cwd());
  }
}

async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 5): Promise<Response> {
  let attempt = 1;
  let wait = 2000;

  while (attempt <= maxRetries) {
    try {
      const response = await fetch(url, options);
      
      // Success
      if (response.ok) return response;

      const bodyText = await response.clone().text();
      const isQuotaError = bodyText.includes('token_quota_exceeded') || response.status === 429;

      if (isQuotaError || response.status === 500) {
        console.warn(`⚠️  Attempt ${attempt}/${maxRetries}: Status ${response.status}. ${isQuotaError ? "Quota exceeded. " : ""}Retrying in ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
        attempt++;
        wait *= 2;
        continue;
      }

      // Hard error
      throw new Error(`Request failed with status ${response.status}: ${bodyText}`);
    } catch (e: any) {
      if (attempt === maxRetries) throw e;
      console.warn(`⚠️  Attempt ${attempt}/${maxRetries}: Network error (${e.message}). Retrying in ${wait / 1000}s...`);
      await new Promise(r => setTimeout(r, wait));
      attempt++;
      wait *= 2;
    }
  }
  throw new Error(`Max retries reached for ${url}`);
}

// --- Main Execution ---

async function main() {
  const isVerbose = process.env.VERBOSE === 'true';
  const repository = getRepositoryContext();
  
  console.log(`--- Searching for relevant subject in ${repository} ---`);

  // 1. Discovery
  const discoveryResponse = await fetchWithRetry(`${WORKER_URL}/api/subjects/search`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query: PROMPT,
      context: { repository, namespacePrefix: NAMESPACE_PREFIX }
    })
  });

  const discoveryData = await discoveryResponse.json() as any;
  const match = discoveryData.matches?.[0];

  if (!match) {
    console.error(`Error: No matching subject found for prompt: ${PROMPT}`);
    process.exit(1);
  }

  console.log(`Found Subject: ${match.title}`);

  // 2. Initialization
  const sessionSlug = match.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const sessionId = `${sessionSlug || 'session'}-${Math.floor(1000 + Math.random() * 9000)}`;
  const specPath = join('docs', 'specs', `${sessionId}.md`);

  console.log(`--- Initializing Speccing Session ---`);
  console.log(`Target File: ${specPath}`);
  
  mkdirSync(join('docs', 'specs'), { recursive: true });
  writeFileSync(specPath, ''); // Touch file

  const startResponse = await fetchWithRetry(`${WORKER_URL}/api/speccing/start?subjectId=${match.id}&sessionId=${sessionId}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      revisionMode: REVISION_MODE,
      momentGraphNamespace: match.metadata?.momentGraphNamespace ?? undefined,
      context: { repository, namespacePrefix: NAMESPACE_PREFIX }
    })
  });

  const startData = await startResponse.json() as any;
  if (!startData.sessionId) {
    console.error(`Error: Failed to initialize session:`, startData);
    process.exit(1);
  }

  // 3. Autonomous Loop
  let turn = 1;
  while (true) {
    console.log(`--- Turn ${turn}: Streaming refinements to ${specPath} ---`);

    const response = await fetchWithRetry(`${WORKER_URL}/api/speccing/next/stream?sessionId=${sessionId}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ userPrompt: PROMPT })
    });

    // Check for metadata or completion
    const metadataB64 = response.headers.get('x-speccing-metadata');
    let metadata: any = null;
    if (metadataB64) {
      metadata = JSON.parse(Buffer.from(metadataB64, 'base64').toString('utf-8'));
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json') || !response.body) {
        const bodyText = await response.text();
        try {
            const data = JSON.parse(bodyText);
            if (data.status === 'completed') {
                console.log(`\n--- Speccing Complete ---`);
                break;
            }
        } catch (e) {
            // Not JSON or parse error, ignore and continue if body exists
            if (!response.body) {
                console.error(`Error: Unexpected non-stream response: ${bodyText}`);
                process.exit(1);
            }
        }
    }

    if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        
        // Clear file for this turn's full rewrite (server-side revision model)
        writeFileSync(specPath, '');

        const startTime = Date.now();
        let firstChunkTime: number | null = null;
        let chunkIdx = 0;

        // Busy indicator
        const chars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
        let charIdx = 0;
        const spinner = setInterval(() => {
            if (firstChunkTime === null) {
                process.stdout.write(`\r${chars[charIdx++ % chars.length]} Thinking... `);
            }
        }, 80);

        let accumulatedBody = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            if (firstChunkTime === null) {
                clearInterval(spinner);
                process.stdout.write('\r          \r'); // Clear spinner
                firstChunkTime = Date.now();
                if (isVerbose) console.log(`\n[debug] First chunk received after ${firstChunkTime - startTime}ms`);
            }

            chunkIdx++;
            const text = decoder.decode(value, { stream: true });
            accumulatedBody += text;
            
            // Only stream to stdout if VERBOSE is true
            if (isVerbose) process.stdout.write(text);
            
            appendFileSync(specPath, text);
        }

        // Final check if the streamed body itself was a completion signal
        try {
            const data = JSON.parse(accumulatedBody);
            if (data.status === 'completed') {
                console.log(`\n--- Speccing Complete (Streamed) ---`);
                break;
            }
        } catch (e) {
            // Not a completion JSON, just content
        }

        const endTime = Date.now();
        if (isVerbose) {
            console.log(`\n[debug] Stream finished. Total time: ${endTime - startTime}ms. Chunks: ${chunkIdx}`);
        } else {
             // In non-verbose mode, print a newline if we were streaming content
             // (though we suppressed content, we might want to separate turns cleanly)
             // Actually, the spinner clear handles the line.
        }
        process.stdout.write('\n');
    }

    if (metadata?.moment) {
      console.log(`✅ Turn ${turn} complete. Processed: ${metadata.moment.title}`);
    }

    turn++;
  }

  console.log(`\nFinal Specification saved to: ${specPath}`);
}

main().catch(err => {
  console.error(`FATAL:`, err);
  process.exit(1);
});
