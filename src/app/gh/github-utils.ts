import { env } from "cloudflare:workers";

declare module "rwsdk/worker" {
  interface WorkerEnv {
    GITHUB_TOKEN?: string;
  }
}

export async function getPullRequestForCommit(
  owner: string,
  repo: string,
  commitSha: string,
  env: Cloudflare.Env
): Promise<number | null> {
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
  return pulls.length > 0 ? pulls[0].number : null;
}



