import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { config } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function signPayload(payload: string, secret: string): Promise<string> {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  return `sha256=${hmac.digest('hex')}`;
}

async function main() {
  const event = process.argv[2] || 'workflow_job';

  // Events are in ../events relative to src/
  const payloadPath = path.join(__dirname, '..', 'events', `${event}.json`);

  if (!fs.existsSync(payloadPath)) {
    const availableEvents = fs.readdirSync(path.join(__dirname, '..', 'events'))
      .map(f => f.replace('.json', ''));
    console.error(`Payload not found: ${payloadPath}`);
    console.error(`Available events: ${availableEvents.join(', ')}`);
    process.exit(1);
  }

  const rawPayload = fs.readFileSync(payloadPath, 'utf-8');
  const payload = JSON.parse(rawPayload);
  const deliveryId = crypto.randomUUID();

  // 1. Seeding Logic for DTU
  if (event === 'workflow_job' && payload.workflow_job) {
    console.log(`[DTU] Seeding mock server at ${config.DTU_URL}...`);
    try {
      const seedResponse = await fetch(`${config.DTU_URL}/_dtu/seed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload.workflow_job),
      });
      if (!seedResponse.ok) {
        console.warn(`[DTU] Warning: Failed to seed mock server: ${seedResponse.status} ${seedResponse.statusText}`);
      } else {
        console.log('[DTU] Mock server seeded successfully.');
      }
    } catch (err) {
      console.warn(`[DTU] Warning: Could not connect to mock server at ${config.DTU_URL}. Is it running?`);
    }
  }

  console.log(`[DTU] Simulating "${event}" event...`);
  console.log(`[DTU] Delivery ID: ${deliveryId}`);
  console.log(`[DTU] Target Bridge: ${config.BRIDGE_URL}`);

  const signature = await signPayload(rawPayload, config.GITHUB_WEBHOOK_SECRET);

  try {
    const response = await fetch(`${config.BRIDGE_URL}/api/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': event,
        'X-GitHub-Delivery': deliveryId,
        'X-Hub-Signature-256': signature,
      },
      body: rawPayload,
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[DTU] Failed to trigger event: ${response.status} ${response.statusText}`);
      console.error(`[DTU] Response: ${text}`);
      process.exit(1);
    }

    console.log('[DTU] Event triggered successfully!');
    const text = await response.text();
    console.log('[DTU] Bridge Response:', text);

  } catch (error: any) {
    if (error.code === 'ECONNREFUSED') {
      console.error(`[DTU] Error: Could not connect to Bridge at ${config.BRIDGE_URL}. Is it running?`);
    } else {
      console.error('[DTU] Error triggering event:', error);
    }
    process.exit(1);
  }
}

main();
