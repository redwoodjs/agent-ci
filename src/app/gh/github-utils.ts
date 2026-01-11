import { env } from "cloudflare:workers";

declare module "rwsdk/worker" {
  interface WorkerEnv {
    GITHUB_TOKEN?: string;
  }
}

/**
 * Parse a GitHub repository identifier into owner and repo.
 * Supports formats:
 * - owner/repo
 * - https://github.com/owner/repo.git
 * - https://github.com/owner/repo
 * - git@github.com:owner/repo.git
 * - git@github.com:owner/repo
 */
export function parseGitHubRepo(
  input: string
): { owner: string; repo: string } | null {
  if (!input || typeof input !== "string") {
    return null;
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // Try owner/repo format first
  const simpleMatch = trimmed.match(/^([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (simpleMatch) {
    return {
      owner: simpleMatch[1],
      repo: simpleMatch[2],
    };
  }

  // Try GitHub URL formats (https://github.com/owner/repo.git or git@github.com:owner/repo.git)
  const urlMatch = trimmed.match(
    /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/
  );
  if (urlMatch) {
    return {
      owner: urlMatch[1],
      repo: urlMatch[2],
    };
  }

  return null;
}

export async function getPullRequestsForCommit(
  owner: string,
  repo: string,
  commitSha: string,
  env: Cloudflare.Env
): Promise<number[]> {
  // Check R2 cache first (commit-to-PR mapping is immutable)
  const cacheKey = `github/${owner}/${repo}/commits/${commitSha}/prs.json`;
  const bucket = env.MACHINEN_BUCKET;

  try {
    const cachedObject = await bucket.get(cacheKey);
    if (cachedObject) {
      const cachedData = (await cachedObject.json()) as number[];
      console.log(
        `[github-cache] Cache hit for commit ${commitSha} in ${owner}/${repo}: ${cachedData.length} PRs`
      );
      return cachedData;
    }
  } catch (err) {
    // Cache miss or error - continue to API call
    console.log(
      `[github-cache] Cache miss for commit ${commitSha} in ${owner}/${repo}, fetching from API`
    );
  }

  // Cache miss - fetch from GitHub API
  const token = (env as any).GITHUB_TOKEN as string | undefined;
  if (!token) {
    throw new Error("GITHUB_TOKEN is not set");
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/commits/${commitSha}/pulls`;
  const response = await fetch(url, {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "machinen-engine/1.0",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `GitHub API error: ${response.status} ${response.statusText} | URL: ${url} | Body: ${errorText.substring(0, 500)}`
    );
  }

  const pulls = (await response.json()) as Array<{ number: number }>;
  const prNumbers = pulls.map((p) => p.number);

  // Store in R2 cache for future requests
  try {
    await bucket.put(cacheKey, JSON.stringify(prNumbers), {
      httpMetadata: {
        contentType: "application/json",
      },
    });
    console.log(
      `[github-cache] Cached PR numbers for commit ${commitSha} in ${owner}/${repo}`
    );
  } catch (err) {
    // Log but don't fail if cache write fails
    console.warn(
      `[github-cache] Failed to cache PR numbers for commit ${commitSha}:`,
      err
    );
  }

  return prNumbers;
}




