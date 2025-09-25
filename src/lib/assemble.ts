export type SourceType = "meeting" | "chat" | "pr" | "issue";

export async function embedWithWorkersAI(
  AI: Ai,
  text: string
): Promise<number[]> {
  // Model outputs 384-d vectors
  const model = "@cf/baai/bge-base-en-v1.5";
  const { data } = await AI.run(model as any, { text });
  return data[0];
}

export interface StructuredSeg {
  title: string;
  summary: string;
  entities: string[];
  actions: string[];
  decisions: string[];
  tags: string[];
  evidence_turns: number[];
  start_line: number;
  end_line: number;
  files?: string[];
  commits?: string[];
  participants?: string[];
  review_state?: string;
  labels?: string[];
  state?: string;
  channels?: string[];
  thread_ids?: string[];
  time_start?: string;
  time_end?: string;
}

export interface RetrievalSeg {
  retrieval_summary: string;
}

export interface CanonicalSeg {
  id: string;
  source_type: SourceType;
  source_id: string;
  segment_index: number;
  title: string;
  retrieval_summary: string;
  text_for_embedding: string;
  metadata: Record<string, any>;
  fingerprints: { content_sha256: string; dedupe_key: string };
  created_at: string;
  updated_at: string;
  version: number;
}

export const zpad = (n: number, width = 4) => String(n).padStart(width, "0");
export const repoSafe = (repo: string) => repo.replace(/\W+/g, "_");

export async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return "sha256:" + hex;
}

export function sanitizeMetadata(
  input: Record<string, any>
): Record<string, any> {
  const limitArray = (arr?: any[], max = 24) =>
    Array.isArray(arr) ? arr.slice(0, max) : undefined;
  const limitStr = (s?: string, max = 800) =>
    typeof s === "string" ? (s.length > max ? s.slice(0, max) : s) : undefined;

  return {
    // required-ish, highly useful fields
    source_type: input.source_type,
    source_id: input.source_id,
    segment_index: input.segment_index,
    title: limitStr(input.title, 200),
    summary: limitStr(input.metadata?.summary, 1200),

    // high-signal join keys (trimmed)
    entities: limitArray(input.metadata?.entities, 50),
    files: limitArray(input.metadata?.files, 50),
    commits: limitArray(input.metadata?.commits, 50),
    decisions: limitArray(input.metadata?.decisions, 20),
    actions: limitArray(input.metadata?.actions, 20),
    tags: limitArray(input.metadata?.tags, 30),

    // useful facets
    review_state: input.metadata?.review_state,
    state: input.metadata?.state,

    // time/people (optional)
    participants: limitArray(input.metadata?.participants, 30),
    time_start: input.metadata?.time_start,
    time_end: input.metadata?.time_end,
  };
}

export async function assemblePRSegmentsFromObjects(opts: {
  repo: string; // "org/repo"
  pr_number: number;
  structuredSegments: StructuredSeg[]; // pass your array directly
  retrievalSegments: RetrievalSeg[]; // pass your array directly
  state?: string; // open | closed | merged
  merged_at?: string;
  labels?: string[];
  version?: number;
}): Promise<CanonicalSeg[]> {
  const now = new Date().toISOString();
  const srcId = `${opts.repo}#${opts.pr_number}`;

  if (opts.structuredSegments.length !== opts.retrievalSegments.length) {
    throw new Error(
      `Length mismatch: structured=${opts.structuredSegments.length} vs retrieval=${opts.retrievalSegments.length}`
    );
  }

  console.log(opts.structuredSegments);

  return Promise.all(
    opts.structuredSegments.map(async (seg, i) => {
      const ret = opts.retrievalSegments[i]?.retrieval_summary ?? "";
      const id = `seg_pr_${repoSafe(opts.repo)}_${opts.pr_number}_${zpad(i)}`;
      const text = ret;
      const contentHash = await sha256(text);

      return {
        id,
        source_type: "pr",
        source_id: srcId,
        segment_index: i,
        title: seg.title,
        retrieval_summary: ret,
        text_for_embedding: text,
        metadata: {
          ...seg, // carry full structured fields
          repo: opts.repo,
          pr_number: opts.pr_number,
          state: opts.state,
          labels: opts.labels ?? [],
          merged_at: opts.merged_at,
        },
        fingerprints: {
          content_sha256: contentHash,
          dedupe_key: `pr:${srcId}:${
            (seg.files ?? []).join(",") || "no-files"
          }:${(seg.decisions ?? []).join(",") || "no-decisions"}`,
        },
        created_at: now,
        updated_at: now,
        version: opts.version ?? 1,
      } as CanonicalSeg;
    })
  );
}

type CanonicalMeetingSeg = {
  id: string;
  source_type: "meeting";
  source_id: string;
  segment_index: number;
  title: string;
  retrieval_summary: string;
  text_for_embedding: string;
  metadata: {
    title?: string;
    summary?: string;
    entities?: string[];
    actions?: string[];
    decisions?: string[];
    tags?: string[];
    evidence_turns?: number[];
    start_line?: number;
    end_line?: number;
    participants?: string[];
    // (time_start/time_end optional; include if you have them)
    time_start?: string;
    time_end?: string;
  };
};

const clip = (s: string | undefined, n = 1200) =>
  typeof s === "string" ? (s.length > n ? s.slice(0, n) : s) : undefined;

const cap = <T>(arr: T[] | undefined, n = 50) =>
  Array.isArray(arr) ? arr.slice(0, n) : undefined;

/** Build flat, trimmed metadata for Vectorize. Omits undefined keys. */
export function sanitizeMeetingMetadata(doc: CanonicalMeetingSeg) {
  const m = doc.metadata ?? {};
  const meta: Record<string, any> = {
    source_type: doc.source_type,
    source_id: doc.source_id,
    segment_index: doc.segment_index,
    title: clip(doc.title, 200),
    summary: clip(m.summary, 1200),

    entities: cap(m.entities, 50),
    actions: cap(m.actions, 20),
    decisions: cap(m.decisions, 20),
    tags: cap(m.tags, 30),

    participants: cap(m.participants, 30),

    // nice to have for traceability
    evidence_turns: cap(m.evidence_turns, 50),
    start_line: m.start_line,
    end_line: m.end_line,

    // include if present
    time_start: m.time_start,
    time_end: m.time_end,
  };
  for (const k of Object.keys(meta)) {
    if (meta[k] === undefined || meta[k] === null) delete meta[k];
  }

  // convert array elements to strings, keep arrays
  for (const k of Object.keys(meta)) {
    if (Array.isArray(meta[k])) {
      meta[k] = (meta[k] as any[]).map((v) => String(v));
    }
  }

  return meta;
}

export async function assembleMeetingSegmentsFromObjects(opts: {
  meetingId: string; // e.g., "2025-09-21-standup-A"
  structuredSegments: StructuredSeg[];
  retrievalSegments: RetrievalSeg[]; // must align 1:1 with structuredSegments
  // Optional meeting-level metadata (applied if segment doesn’t already include them)
  participants?: string[];
  time_start?: string;
  time_end?: string;
  version?: number;
}): Promise<CanonicalSeg[]> {
  const { meetingId, structuredSegments, retrievalSegments } = opts;

  if (structuredSegments.length !== retrievalSegments.length) {
    throw new Error(
      `Length mismatch: structured=${structuredSegments.length} vs retrieval=${retrievalSegments.length}`
    );
  }

  const now = new Date().toISOString();

  return Promise.all(
    structuredSegments.map(async (seg, i) => {
      const ret = retrievalSegments[i]?.retrieval_summary ?? "";
      const id = `seg_meeting_${meetingId}_${zpad(i)}`;
      const text = ret; // keep it tight; widen later if you need more recall

      // Segment-level metadata (only allowed keys) + fallback to meeting-level context
      const metadata: CanonicalMeetingSeg["metadata"] = {
        title: seg.title,
        summary: seg.summary,
        entities: seg.entities,
        actions: seg.actions,
        decisions: seg.decisions,
        tags: seg.tags,
        evidence_turns: seg.evidence_turns,
        start_line: seg.start_line,
        end_line: seg.end_line,
        participants: seg.participants ?? opts.participants ?? [],
        time_start: seg.time_start ?? opts.time_start,
        time_end: seg.time_end ?? opts.time_end,
      };

      const doc: CanonicalSeg = {
        id,
        source_type: "meeting",
        source_id: meetingId,
        segment_index: i,
        title: seg.title,
        retrieval_summary: ret,
        text_for_embedding: text,
        metadata,
        fingerprints: {
          content_sha256: await sha256(text),
          dedupe_key: `meeting:${meetingId}:segment:${i}`,
        },
        created_at: now,
        updated_at: now,
        version: opts.version ?? 1,
      };

      return doc;
    })
  );
}
