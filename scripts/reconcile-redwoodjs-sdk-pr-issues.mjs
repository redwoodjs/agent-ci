const DEFAULT_URL = "https://machinen.redwoodjs.workers.dev";

function parseArgs(argv) {
  const args = {
    url: DEFAULT_URL,
    dryRun: true,
    batchSize: 10,
    maxNumbers: null,
    maxLoops: 10_000,
    sleepMs: 250,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") {
      args.url = String(argv[i + 1] ?? "");
      i++;
      continue;
    }
    if (a === "--apply") {
      args.dryRun = false;
      continue;
    }
    if (a === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (a === "--batch-size") {
      args.batchSize = Number(argv[i + 1] ?? args.batchSize);
      i++;
      continue;
    }
    if (a === "--max-numbers") {
      const raw = argv[i + 1];
      args.maxNumbers =
        raw === undefined || raw === null || String(raw).trim().length === 0
          ? null
          : Number(raw);
      i++;
      continue;
    }
    if (a === "--max-loops") {
      args.maxLoops = Number(argv[i + 1] ?? args.maxLoops);
      i++;
      continue;
    }
    if (a === "--sleep-ms") {
      args.sleepMs = Number(argv[i + 1] ?? args.sleepMs);
      i++;
      continue;
    }
  }

  if (!Number.isFinite(args.batchSize) || args.batchSize <= 0) {
    throw new Error(`Invalid --batch-size: ${args.batchSize}`);
  }
  args.batchSize = Math.floor(args.batchSize);

  if (!Number.isFinite(args.maxLoops) || args.maxLoops <= 0) {
    throw new Error(`Invalid --max-loops: ${args.maxLoops}`);
  }
  args.maxLoops = Math.floor(args.maxLoops);

  if (!Number.isFinite(args.sleepMs) || args.sleepMs < 0) {
    throw new Error(`Invalid --sleep-ms: ${args.sleepMs}`);
  }
  args.sleepMs = Math.floor(args.sleepMs);

  if (args.maxNumbers !== null) {
    if (!Number.isFinite(args.maxNumbers) || args.maxNumbers <= 0) {
      throw new Error(`Invalid --max-numbers: ${args.maxNumbers}`);
    }
    args.maxNumbers = Math.floor(args.maxNumbers);
  }

  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url, apiKey, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response: ${text}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.INGEST_API_KEY || process.env.API_KEY;
  if (!apiKey) {
    throw new Error("Set INGEST_API_KEY (or API_KEY) in env");
  }

  const endpoint = `${args.url}/admin/reconcile-redwoodjs-sdk-pr-issues`;

  for (let i = 0; i < args.maxLoops; i++) {
    const startedAt = Date.now();
    const payload = {
      dryRun: args.dryRun,
      batchSize: args.batchSize,
    };
    if (args.maxNumbers !== null) {
      payload.maxNumbers = args.maxNumbers;
    }

    const result = await postJson(endpoint, apiKey, payload);

    const mismatches =
      typeof result?.mismatches === "number" ? result.mismatches : null;
    const remaining =
      typeof result?.remainingMismatches === "number"
        ? result.remainingMismatches
        : null;
    const batchSize =
      typeof result?.batchSize === "number" ? result.batchSize : null;

    const r2MovesCount = Array.isArray(result?.r2Moves)
      ? result.r2Moves.length
      : 0;
    const mgUpdates =
      result?.momentGraphUpdates &&
      typeof result.momentGraphUpdates === "object"
        ? result.momentGraphUpdates.updates || null
        : null;
    const isUpdates =
      result?.indexingStateUpdates &&
      typeof result.indexingStateUpdates === "object"
        ? result.indexingStateUpdates.updates || null
        : null;
    const replayPayloadUpdated =
      typeof result?.replayItemPayloadUpdates?.updated === "number"
        ? result.replayItemPayloadUpdates.updated
        : null;

    const elapsedMs = Date.now() - startedAt;
    process.stdout.write(
      JSON.stringify(
        {
          loop: i + 1,
          dryRun: args.dryRun,
          batchSize,
          mismatches,
          remainingMismatches: remaining,
          r2Moves: r2MovesCount,
          replayItemPayloadUpdates: replayPayloadUpdated,
          momentGraphUpdates: mgUpdates,
          indexingStateUpdates: isUpdates,
          elapsedMs,
        },
        null,
        2
      ) + "\n"
    );

    if (mismatches === 0 || remaining === 0) {
      break;
    }

    if (args.sleepMs > 0) {
      await sleep(args.sleepMs);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
