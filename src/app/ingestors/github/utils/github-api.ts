import { env } from "cloudflare:workers";

declare module "rwsdk/worker" {
  interface WorkerEnv {
    GITHUB_TOKEN?: string;
  }
}

export async function fetchGitHubEntity<T>(
  url: string
): Promise<T> {
  const token = (env as any).GITHUB_TOKEN as string | undefined;
  if (!token) {
    throw new Error("GITHUB_TOKEN is not set");
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "machinen-github-ingestor/1.0",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `GitHub API error: ${response.status} ${response.statusText} | URL: ${url} | Body: ${errorText.substring(0, 500)}`
    );
  }

  return (await response.json()) as T;
}

