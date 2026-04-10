import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export interface RemoteWorkflowRef {
  owner: string;
  repo: string;
  path: string;
  ref: string;
  raw: string;
}

/**
 * Parse a remote reusable workflow ref string.
 * Format: owner/repo/path/to/file.yml@ref
 */
export function parseRemoteRef(uses: string): RemoteWorkflowRef | null {
  const atIdx = uses.lastIndexOf("@");
  if (atIdx < 0) {
    return null;
  }

  const pathPart = uses.slice(0, atIdx);
  const ref = uses.slice(atIdx + 1);
  if (!ref) {
    return null;
  }

  const segments = pathPart.split("/");
  if (segments.length < 3) {
    return null;
  }

  return {
    owner: segments[0],
    repo: segments[1],
    path: segments.slice(2).join("/"),
    ref,
    raw: uses,
  };
}

/** Returns true for 40-character hex SHA refs (immutable, safe to cache forever). */
export function isShaRef(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref);
}

/** Build the local cache path for a remote workflow file. */
export function remoteCachePath(cacheDir: string, ref: RemoteWorkflowRef): string {
  const sanitizedRef = ref.ref.replace(/[^a-zA-Z0-9._-]/g, "-");
  return path.join(cacheDir, `${ref.owner}__${ref.repo}@${sanitizedRef}`, ref.path);
}

/**
 * Scan a workflow YAML and prefetch all remote reusable workflow refs.
 * Downloaded files are written to cacheDir.
 *
 * - SHA refs: cached forever (immutable)
 * - Tag/branch refs: always re-fetched (mutable)
 *
 * Authentication is opt-in via the `githubToken` parameter.
 * Public repos may work without auth (within rate limits).
 * On 401/403 responses, throws with instructions for how to authenticate.
 */
export async function prefetchRemoteWorkflows(
  workflowPath: string,
  cacheDir: string,
  githubToken?: string,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();

  const raw = parseYaml(fs.readFileSync(workflowPath, "utf-8"));
  const jobs = raw?.jobs ?? {};

  const remoteRefs: RemoteWorkflowRef[] = [];
  for (const [, jobDef] of Object.entries<any>(jobs)) {
    const uses = jobDef?.uses;
    if (typeof uses === "string" && !uses.startsWith("./")) {
      const ref = parseRemoteRef(uses);
      if (ref) {
        remoteRefs.push(ref);
      }
    }
  }

  if (remoteRefs.length === 0) {
    return resolved;
  }

  const errors: string[] = [];

  await Promise.all(
    remoteRefs.map(async (ref) => {
      const dest = remoteCachePath(cacheDir, ref);

      // Cache hit for SHA refs (immutable — safe to skip)
      if (isShaRef(ref.ref) && fs.existsSync(dest)) {
        resolved.set(ref.raw, dest);
        return;
      }

      try {
        const url = `https://api.github.com/repos/${ref.owner}/${ref.repo}/contents/${ref.path}?ref=${ref.ref}`;
        const headers: Record<string, string> = {
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "agent-ci/1.0",
        };
        if (githubToken) {
          headers["Authorization"] = `token ${githubToken}`;
        }

        const response = await fetch(url, { headers });
        if (!response.ok) {
          const hint =
            response.status === 401 || response.status === 403
              ? ` Run with: agent-ci run --github-token\n  Or set: export AGENT_CI_GITHUB_TOKEN=$(gh auth token)`
              : "";
          errors.push(
            `Failed to fetch remote workflow ${ref.raw} (HTTP ${response.status}).${hint}`,
          );
          return;
        }

        const data = (await response.json()) as { content?: string; encoding?: string };
        if (!data.content || data.encoding !== "base64") {
          errors.push(`Unexpected response format for remote workflow ${ref.raw}`);
          return;
        }

        const content = Buffer.from(data.content, "base64").toString("utf-8");
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content, "utf-8");
        resolved.set(ref.raw, dest);
      } catch (err: any) {
        errors.push(`Error fetching remote workflow ${ref.raw}: ${err.message}`);
      }
    }),
  );

  if (errors.length > 0) {
    throw new Error(`[Agent CI] Remote workflow fetch failed:\n  ${errors.join("\n  ")}`);
  }

  return resolved;
}
