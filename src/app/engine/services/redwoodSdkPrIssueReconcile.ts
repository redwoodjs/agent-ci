import { createDb, type Database, sql } from "rwsdk/db";
import { env } from "cloudflare:workers";
import { qualifyName } from "@/app/engine/momentGraphNamespace";
import { type indexingStateMigrations } from "@/app/engine/db/migrations";
import type { EngineIndexingStateDO } from "@/app/engine/db/durableObject";
import { type momentMigrations } from "@/app/engine/momentDb/migrations";
import type { MomentGraphDO } from "@/app/engine/momentDb/durableObject";

type IndexingStateDatabase = Database<typeof indexingStateMigrations>;
type MomentDatabase = Database<typeof momentMigrations>;

type ReconcileOptions = {
  dryRun: boolean;
  momentGraphNamespace: string | null;
  momentGraphNamespacePrefix: string | null;
  maxNumbers?: number | null;
  batchSize?: number | null;
};

type GitHubIssueListItem = {
  number: number;
  pull_request?: unknown;
};

function getIndexingStateDb(momentGraphNamespace: string | null) {
  return createDb<IndexingStateDatabase>(
    (env as any)
      .ENGINE_INDEXING_STATE as DurableObjectNamespace<EngineIndexingStateDO>,
    qualifyName("engine-indexing-state", momentGraphNamespace)
  );
}

function getMomentGraphDb(momentGraphNamespace: string | null) {
  return createDb<MomentDatabase>(
    (env as any).MOMENT_GRAPH_DO as DurableObjectNamespace<MomentGraphDO>,
    qualifyName("moment-graph-v2", momentGraphNamespace)
  );
}

function githubTokenOrThrow(): string {
  const token = (env as any).GITHUB_TOKEN as string | undefined;
  if (!token) {
    throw new Error("GITHUB_TOKEN is not set");
  }
  return token;
}

async function fetchGitHubIssuesPage(input: {
  owner: string;
  repo: string;
  page?: number;
}): Promise<{ data: GitHubIssueListItem[]; nextPage: number | null }> {
  const token = githubTokenOrThrow();
  const page =
    typeof input.page === "number" && input.page > 0 ? input.page : 1;
  const url = `https://api.github.com/repos/${input.owner}/${input.repo}/issues?state=all&per_page=100&page=${page}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "machinen-reconcile/1.0",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `GitHub API error: ${res.status} ${
        res.statusText
      } | URL: ${url} | Body: ${body.substring(0, 500)}`
    );
  }
  const data = (await res.json()) as GitHubIssueListItem[];
  const link = res.headers.get("Link");
  let nextPage: number | null = null;
  if (link && link.includes('rel="next"')) {
    const nextLink = link
      .split(",")
      .map((s) => s.trim())
      .find((s) => s.includes('rel="next"'));
    const m = nextLink?.match(/[?&]page=(\d+)/);
    if (m) {
      const n = Number(m[1]);
      nextPage = Number.isFinite(n) ? n : null;
    }
  }
  return { data, nextPage };
}

async function classifyNumbersFromGitHub(input: {
  owner: string;
  repo: string;
  maxNumbers?: number | null;
}): Promise<{ isPullRequest: Set<number>; isIssue: Set<number> }> {
  const isPullRequest = new Set<number>();
  const isIssue = new Set<number>();

  let page: number | null = 1;
  let seen = 0;
  const maxNumbers =
    typeof input.maxNumbers === "number" &&
    Number.isFinite(input.maxNumbers) &&
    input.maxNumbers > 0
      ? Math.floor(input.maxNumbers)
      : null;

  for (let guard = 0; guard < 10_000 && page !== null; guard++) {
    const { data, nextPage } = await fetchGitHubIssuesPage({
      owner: input.owner,
      repo: input.repo,
      page,
    });
    for (const item of data) {
      if (typeof item?.number !== "number" || !Number.isFinite(item.number)) {
        continue;
      }
      const n = Math.floor(item.number);
      if (item.pull_request) {
        isPullRequest.add(n);
      } else {
        isIssue.add(n);
      }
      seen += 1;
      if (maxNumbers !== null && seen >= maxNumbers) {
        return { isPullRequest, isIssue };
      }
    }
    page = nextPage;
  }

  return { isPullRequest, isIssue };
}

async function listAllR2Keys(prefix: string): Promise<string[]> {
  const bucket = (env as any).MACHINEN_BUCKET as R2Bucket;
  const keys: string[] = [];
  let cursor: string | undefined = undefined;
  for (let guard = 0; guard < 100_000; guard++) {
    const res = await bucket.list({
      prefix,
      cursor,
      limit: 1000,
    });
    for (const obj of res.objects) {
      if (typeof obj?.key === "string") {
        keys.push(obj.key);
      }
    }
    if (!res.truncated) {
      break;
    }
    cursor = res.cursor;
  }
  return keys;
}

async function moveR2Prefix(input: {
  fromPrefix: string;
  toPrefix: string;
  dryRun: boolean;
}): Promise<{ moved: number; missing: number }> {
  const bucket = (env as any).MACHINEN_BUCKET as R2Bucket;
  const keys = await listAllR2Keys(input.fromPrefix);
  let moved = 0;
  let missing = 0;
  for (const key of keys) {
    const suffix = key.startsWith(input.fromPrefix)
      ? key.slice(input.fromPrefix.length)
      : null;
    if (suffix === null) {
      continue;
    }
    const nextKey = `${input.toPrefix}${suffix}`;
    if (input.dryRun) {
      moved += 1;
      continue;
    }
    const obj = await bucket.get(key);
    if (!obj) {
      missing += 1;
      continue;
    }
    await bucket.put(nextKey, obj.body, {
      httpMetadata: obj.httpMetadata,
      customMetadata: obj.customMetadata,
    });
    await bucket.delete(key);
    moved += 1;
  }
  return { moved, missing };
}

async function updateMomentGraphDocumentIds(input: {
  momentGraphNamespace: string | null;
  mappings: Array<{ from: string; to: string }>;
  dryRun: boolean;
}): Promise<{ updates: Record<string, number> }> {
  const db = getMomentGraphDb(input.momentGraphNamespace);
  const updates: Record<string, number> = {};

  const tables = [
    { table: "moments", column: "document_id" },
    { table: "micro_moments", column: "document_id" },
    { table: "micro_moment_batches", column: "document_id" },
    { table: "document_audit_logs", column: "document_id" },
  ] as const;

  for (const map of input.mappings) {
    for (const t of tables) {
      const key = `${t.table}.${t.column}`;
      if (input.dryRun) {
        continue;
      }
      const result = await db
        .updateTable(t.table as any)
        .set({ [t.column]: map.to } as any)
        .where(t.column as any, "=", map.from)
        .executeTakeFirst();
      const updated =
        typeof (result as any)?.numUpdatedRows === "bigint"
          ? Number((result as any).numUpdatedRows)
          : Number((result as any)?.numUpdatedRows ?? 0);
      updates[key] = (updates[key] ?? 0) + updated;
    }

    // document_structure_hash is cache-like; drop the old key so it can be rebuilt if needed.
    if (!input.dryRun) {
      await db
        .deleteFrom("document_structure_hash")
        .where("document_id", "=", map.from)
        .execute();
    }
  }

  return { updates };
}

async function moveIndexingStateKey(input: {
  from: string;
  to: string;
  dryRun: boolean;
}): Promise<{ moved: boolean }> {
  const db = getIndexingStateDb(null);
  if (input.dryRun) {
    return { moved: false };
  }
  const row = await db
    .selectFrom("indexing_state")
    .selectAll()
    .where("r2_key", "=", input.from)
    .executeTakeFirst();
  if (!row) {
    return { moved: false };
  }
  await db
    .insertInto("indexing_state")
    .values({
      ...(row as any),
      r2_key: input.to,
    })
    .onConflict((oc) => oc.column("r2_key").doNothing())
    .execute();
  await db
    .deleteFrom("indexing_state")
    .where("r2_key", "=", input.from)
    .execute();
  return { moved: true };
}

async function updateIndexingStateReferences(input: {
  mappings: Array<{ from: string; to: string }>;
  dryRun: boolean;
}): Promise<{ updates: Record<string, number> }> {
  const db = getIndexingStateDb(null);
  const updates: Record<string, number> = {};

  const tables = [
    { table: "moment_replay_items", column: "document_id" },
    { table: "moment_replay_stream_state", column: "document_id" },
    { table: "moment_replay_document_results", column: "r2_key" },
  ] as const;

  for (const map of input.mappings) {
    for (const t of tables) {
      const key = `${t.table}.${t.column}`;
      if (input.dryRun) {
        continue;
      }
      const result = await db
        .updateTable(t.table as any)
        .set({ [t.column]: map.to } as any)
        .where(t.column as any, "=", map.from)
        .executeTakeFirst();
      const updated =
        typeof (result as any)?.numUpdatedRows === "bigint"
          ? Number((result as any).numUpdatedRows)
          : Number((result as any)?.numUpdatedRows ?? 0);
      updates[key] = (updates[key] ?? 0) + updated;
    }
  }

  return { updates };
}

function parseNumberFromLatestKey(
  key: string
): { kind: "issues" | "pull-requests"; number: number } | null {
  const m = key.match(
    /^github\/redwoodjs\/sdk\/(issues|pull-requests)\/(\d+)\/latest\.json$/
  );
  if (!m) {
    return null;
  }
  const number = Number(m[2]);
  if (!Number.isFinite(number)) {
    return null;
  }
  return {
    kind: m[1] === "pull-requests" ? "pull-requests" : "issues",
    number: Math.floor(number),
  };
}

async function listReferencedLatestKeysFromIndexingStateDb(): Promise<
  string[]
> {
  const db = getIndexingStateDb(null);
  const out = new Set<string>();

  const queries = [
    db
      .selectFrom("moment_replay_items")
      .select(["document_id"])
      .distinct()
      .where("document_id", "like", "github/redwoodjs/sdk/%/latest.json"),
    db
      .selectFrom("moment_replay_stream_state")
      .select(["document_id"])
      .distinct()
      .where("document_id", "like", "github/redwoodjs/sdk/%/latest.json"),
    db
      .selectFrom("moment_replay_document_results")
      .select(["r2_key"])
      .distinct()
      .where("r2_key", "like", "github/redwoodjs/sdk/%/latest.json"),
    db
      .selectFrom("indexing_state")
      .select(["r2_key"])
      .distinct()
      .where("r2_key", "like", "github/redwoodjs/sdk/%/latest.json"),
  ] as const;

  for (const q of queries) {
    const rows = (await q.execute()) as any[];
    for (const row of rows) {
      const raw = row?.document_id ?? row?.r2_key;
      if (typeof raw === "string" && raw.length > 0) {
        out.add(raw);
      }
    }
  }

  return Array.from(out);
}

async function listReferencedLatestKeysFromMomentGraphDb(input: {
  momentGraphNamespace: string | null;
}): Promise<string[]> {
  const db = getMomentGraphDb(input.momentGraphNamespace);
  const out = new Set<string>();

  const queries = [
    db
      .selectFrom("moments")
      .select(["document_id"])
      .distinct()
      .where("document_id", "like", "github/redwoodjs/sdk/%/latest.json"),
    db
      .selectFrom("micro_moments")
      .select(["document_id"])
      .distinct()
      .where("document_id", "like", "github/redwoodjs/sdk/%/latest.json"),
    db
      .selectFrom("micro_moment_batches")
      .select(["document_id"])
      .distinct()
      .where("document_id", "like", "github/redwoodjs/sdk/%/latest.json"),
    db
      .selectFrom("document_audit_logs")
      .select(["document_id"])
      .distinct()
      .where("document_id", "like", "github/redwoodjs/sdk/%/latest.json"),
  ] as const;

  for (const q of queries) {
    const rows = (await q.execute()) as any[];
    for (const row of rows) {
      const raw = row?.document_id;
      if (typeof raw === "string" && raw.length > 0) {
        out.add(raw);
      }
    }
  }

  return Array.from(out);
}

function computeMappingsFromReferences(input: {
  owner: string;
  repo: string;
  references: string[];
  isPullRequest: Set<number>;
}): Array<{
  number: number;
  fromKind: "issues" | "pull-requests";
  toKind: "issues" | "pull-requests";
}> {
  const mismatches: Array<{
    number: number;
    fromKind: "issues" | "pull-requests";
    toKind: "issues" | "pull-requests";
  }> = [];

  for (const key of input.references) {
    const parsed = parseNumberFromLatestKey(key);
    if (!parsed) {
      continue;
    }
    const expectedKind: "issues" | "pull-requests" = input.isPullRequest.has(
      parsed.number
    )
      ? "pull-requests"
      : "issues";
    if (parsed.kind !== expectedKind) {
      mismatches.push({
        number: parsed.number,
        fromKind: parsed.kind,
        toKind: expectedKind,
      });
    }
  }

  return mismatches;
}

async function updateIndexingStateReplayItemPayloads(input: {
  mappings: Array<{
    from: string;
    to: string;
    toKind: "issues" | "pull-requests";
  }>;
  dryRun: boolean;
}): Promise<{ updated: number; matched: number }> {
  const db = getIndexingStateDb(null);

  let matched = 0;
  let updated = 0;

  for (const map of input.mappings) {
    const toType = map.toKind === "pull-requests" ? "pull-request" : "issue";
    const rows = (await db
      .selectFrom("moment_replay_items")
      .select(["run_id", "item_id", "payload_json", "document_id"])
      .where((eb) =>
        eb.or([
          eb("document_id", "=", map.from),
          eb("payload_json", "like", `%${map.from}%` as any),
        ])
      )
      .execute()) as any[];

    for (const row of rows) {
      const runId = typeof row?.run_id === "string" ? row.run_id : null;
      const itemId = typeof row?.item_id === "string" ? row.item_id : null;
      if (!runId || !itemId) {
        continue;
      }

      matched += 1;

      const payloadRaw = row?.payload_json;
      const payload =
        typeof payloadRaw === "string"
          ? (() => {
              try {
                return JSON.parse(payloadRaw);
              } catch {
                return null;
              }
            })()
          : payloadRaw && typeof payloadRaw === "object"
          ? payloadRaw
          : null;
      if (!payload || typeof payload !== "object") {
        continue;
      }

      const doc = (payload as any)?.document;
      const beforeId = doc?.id;
      const beforeType = doc?.type;

      let changed = false;
      if (doc && typeof beforeId === "string" && beforeId === map.from) {
        doc.id = map.to;
        changed = true;
      }
      if (doc && (beforeType === "issue" || beforeType === "pull-request")) {
        if (doc.type !== toType) {
          doc.type = toType;
          changed = true;
        }
      }

      if (!changed) {
        continue;
      }

      if (input.dryRun) {
        updated += 1;
        continue;
      }

      await db
        .updateTable("moment_replay_items")
        .set({ payload_json: JSON.stringify(payload) } as any)
        .where("run_id", "=", runId)
        .where("item_id", "=", itemId)
        .execute();

      updated += 1;
    }
  }

  return { matched, updated };
}

export async function reconcileRedwoodSdkPrsAndIssues(
  options: ReconcileOptions
): Promise<any> {
  const owner = "redwoodjs";
  const repo = "sdk";

  const { isPullRequest } = await classifyNumbersFromGitHub({
    owner,
    repo,
    maxNumbers: options.maxNumbers ?? null,
  });

  const issueLatestPrefix = `github/${owner}/${repo}/issues/`;
  const prLatestPrefix = `github/${owner}/${repo}/pull-requests/`;

  const issueLatestKeys = await listAllR2Keys(issueLatestPrefix);
  const prLatestKeys = await listAllR2Keys(prLatestPrefix);

  const r2Mismatches: Array<{
    number: number;
    fromKind: "issues" | "pull-requests";
    toKind: "issues" | "pull-requests";
  }> = [];

  for (const key of issueLatestKeys) {
    const parsed = parseNumberFromLatestKey(key);
    if (!parsed || parsed.kind !== "issues") {
      continue;
    }
    if (isPullRequest.has(parsed.number)) {
      r2Mismatches.push({
        number: parsed.number,
        fromKind: "issues",
        toKind: "pull-requests",
      });
    }
  }

  for (const key of prLatestKeys) {
    const parsed = parseNumberFromLatestKey(key);
    if (!parsed || parsed.kind !== "pull-requests") {
      continue;
    }
    if (!isPullRequest.has(parsed.number)) {
      r2Mismatches.push({
        number: parsed.number,
        fromKind: "pull-requests",
        toKind: "issues",
      });
    }
  }

  const indexingStateReferences =
    await listReferencedLatestKeysFromIndexingStateDb();
  const momentGraphReferences = await listReferencedLatestKeysFromMomentGraphDb(
    {
      momentGraphNamespace: options.momentGraphNamespace,
    }
  );

  const dbMismatches = computeMappingsFromReferences({
    owner,
    repo,
    references: Array.from(
      new Set([...indexingStateReferences, ...momentGraphReferences])
    ),
    isPullRequest,
  });

  const mismatchKey = (m: {
    number: number;
    fromKind: string;
    toKind: string;
  }) => `${m.number}:${m.fromKind}->${m.toKind}`;
  const mismatchMap = new Map<string, any>();
  for (const m of [...r2Mismatches, ...dbMismatches]) {
    mismatchMap.set(mismatchKey(m), m);
  }
  const mismatches = Array.from(mismatchMap.values()) as Array<{
    number: number;
    fromKind: "issues" | "pull-requests";
    toKind: "issues" | "pull-requests";
  }>;

  mismatches.sort((a, b) => {
    if (a.number !== b.number) {
      return a.number - b.number;
    }
    const aKey = `${a.fromKind}->${a.toKind}`;
    const bKey = `${b.fromKind}->${b.toKind}`;
    return aKey.localeCompare(bKey);
  });

  const batchSizeRaw = options.batchSize;
  const batchSize =
    typeof batchSizeRaw === "number" &&
    Number.isFinite(batchSizeRaw) &&
    batchSizeRaw > 0
      ? Math.floor(batchSizeRaw)
      : typeof batchSizeRaw === "string" &&
        Number.isFinite(Number(batchSizeRaw))
      ? Math.floor(Number(batchSizeRaw))
      : 10;

  const batchMismatches = mismatches.slice(0, batchSize);

  const remainingMismatches =
    mismatches.length > batchMismatches.length
      ? mismatches.length - batchMismatches.length
      : 0;

  const mappings: Array<{ from: string; to: string }> = batchMismatches.map(
    (m) => {
      const from = `github/${owner}/${repo}/${m.fromKind}/${m.number}/latest.json`;
      const to = `github/${owner}/${repo}/${m.toKind}/${m.number}/latest.json`;
      return { from, to };
    }
  );

  const r2Moves: Array<any> = [];
  for (const m of batchMismatches) {
    const fromPrefix = `github/${owner}/${repo}/${m.fromKind}/${m.number}/`;
    const toPrefix = `github/${owner}/${repo}/${m.toKind}/${m.number}/`;
    const res = await moveR2Prefix({
      fromPrefix,
      toPrefix,
      dryRun: options.dryRun,
    });
    r2Moves.push({ ...m, fromPrefix, toPrefix, ...res });
  }

  const momentGraphUpdates = await updateMomentGraphDocumentIds({
    momentGraphNamespace: options.momentGraphNamespace,
    mappings,
    dryRun: options.dryRun,
  });

  const indexingStateKeyMoves: Array<any> = [];
  for (const map of mappings) {
    const moved = await moveIndexingStateKey({
      from: map.from,
      to: map.to,
      dryRun: options.dryRun,
    });
    indexingStateKeyMoves.push({ ...map, ...moved });
  }

  const indexingStateUpdates = await updateIndexingStateReferences({
    mappings,
    dryRun: options.dryRun,
  });

  const replayItemPayloadUpdates = await updateIndexingStateReplayItemPayloads({
    mappings: batchMismatches.map((m) => ({
      from: `github/${owner}/${repo}/${m.fromKind}/${m.number}/latest.json`,
      to: `github/${owner}/${repo}/${m.toKind}/${m.number}/latest.json`,
      toKind: m.toKind,
    })),
    dryRun: options.dryRun,
  });

  return {
    owner,
    repo,
    dryRun: options.dryRun,
    momentGraphNamespace: options.momentGraphNamespace,
    momentGraphNamespacePrefix: options.momentGraphNamespacePrefix,
    batchSize,
    githubClassified: {
      pullRequests: isPullRequest.size,
    },
    scanned: {
      issueKeys: issueLatestKeys.length,
      pullRequestKeys: prLatestKeys.length,
    },
    references: {
      indexingState: indexingStateReferences.length,
      momentGraph: momentGraphReferences.length,
    },
    mismatches: mismatches.length,
    mismatchesBySource: {
      r2: r2Mismatches.length,
      db: dbMismatches.length,
    },
    remainingMismatches,
    mappings,
    r2Moves,
    momentGraphUpdates,
    indexingStateKeyMoves,
    indexingStateUpdates,
    replayItemPayloadUpdates,
  };
}
