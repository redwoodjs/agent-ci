import { env } from "cloudflare:workers";
import { getBackfillState, updateBackfillState } from "./backfill-state";
import type { SchedulerJobMessage } from "./backfill-types";
import { formatLog } from "../utils/inspect";

declare module "rwsdk/worker" {
  interface WorkerEnv {
    GITHUB_TOKEN?: string;
    SCHEDULER_QUEUE: Queue<SchedulerJobMessage>;
    PROCESSOR_QUEUE: Queue;
  }
}

interface GitHubApiResponse<T> {
  data: T[];
  headers: Headers;
}

async function fetchGitHubPage<T>(
  url: string,
  page?: string
): Promise<{ data: T[]; nextPage?: string }> {
  const token = (env as any).GITHUB_TOKEN as string | undefined;
  if (!token) {
    console.error("[scheduler] GITHUB_TOKEN is not set");
    throw new Error("GITHUB_TOKEN is not set");
  }

  const fullUrl = page ? `${url}?per_page=100&page=${page}` : `${url}?per_page=100`;
  console.log(formatLog("[scheduler] Fetching GitHub API:", { url: fullUrl, hasToken: !!token, tokenLength: token.length, tokenPrefix: token.substring(0, 4) }));

  const response = await fetch(fullUrl, {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "machinen-github-ingestor/1.0",
    },
  });

  console.log(formatLog("[scheduler] GitHub API response:", { status: response.status, statusText: response.statusText, ok: response.ok }));

  if (!response.ok) {
    const errorText = await response.text();
    console.error(formatLog("[scheduler] GitHub API error:", { status: response.status, statusText: response.statusText, url: fullUrl, errorBody: errorText }));
    throw new Error(`GitHub API error: ${response.status} ${response.statusText} | URL: ${fullUrl} | Body: ${errorText.substring(0, 500)}`);
  }

  const data = (await response.json()) as T[];
  const linkHeader = response.headers.get("Link");
  let nextPage: string | undefined;

  if (linkHeader) {
    const links = linkHeader.split(",");
    const nextLink = links.find((link) => link.includes('rel="next"'));
    if (nextLink) {
      const match = nextLink.match(/[?&]page=(\d+)/);
      if (match) {
        nextPage = match[1];
      }
    }
  }

  return { data, nextPage };
}

export async function processSchedulerJob(message: SchedulerJobMessage): Promise<void> {
  const { repository_key, owner, repo, entity_type, cursor } = message;

  console.log(formatLog("[scheduler] Processing scheduler job:", { repository_key, owner, repo, entity_type, cursor }));

  const state = await getBackfillState(repository_key);
  console.log(formatLog("[scheduler] Current backfill state:", state));

  if (state?.status === "paused_on_error") {
    console.log(`[scheduler] Backfill paused for ${repository_key}, skipping`);
    return;
  }

  const isTestRun = state?.test_run ?? false;
  console.log(`[scheduler] Test run mode: ${isTestRun}`);

  await updateBackfillState(repository_key, { status: "in_progress" });

  try {
    let url: string;
    let cursorField: keyof typeof state;

    switch (entity_type) {
      case "issues":
        url = `https://api.github.com/repos/${owner}/${repo}/issues`;
        cursorField = "issues_cursor";
        break;
      case "pull_requests":
        url = `https://api.github.com/repos/${owner}/${repo}/pulls`;
        cursorField = "pull_requests_cursor";
        break;
      case "comments":
        url = `https://api.github.com/repos/${owner}/${repo}/issues/comments`;
        cursorField = "comments_cursor";
        break;
      case "releases":
        url = `https://api.github.com/repos/${owner}/${repo}/releases`;
        cursorField = "releases_cursor";
        break;
      case "projects":
        url = `https://api.github.com/orgs/${owner}/projects`;
        cursorField = "projects_cursor";
        break;
      default:
        throw new Error(`Unknown entity type: ${entity_type}`);
    }

    const { data, nextPage } = await fetchGitHubPage(url, cursor);

    console.log(formatLog("[scheduler] Fetched data:", { entityType: entity_type, count: data.length, hasNextPage: !!nextPage, nextPage }));

    const processorQueue = (env as any).PROCESSOR_QUEUE as Queue;

    console.log(formatLog("[scheduler] Enqueueing processor jobs:", { count: data.length, entityType: entity_type }));

    for (const entity of data) {
      await processorQueue.send({
        type: "processor",
        repository_key,
        owner,
        repo,
        entity_type: entity_type === "pull_requests" ? "pull_request" : (entity_type.slice(0, -1) as any),
        entity_data: entity,
        event_type: "backfill",
      });
    }

    console.log(formatLog("[scheduler] Enqueued all processor jobs:", { count: data.length, entityType: entity_type }));

    if (isTestRun) {
      console.log(`[scheduler] Test run complete for ${repository_key} - processed first page of ${entity_type}`);
      await updateBackfillState(repository_key, {
        status: "completed",
        [cursorField]: null,
      });
      return;
    }

    if (nextPage) {
      await updateBackfillState(repository_key, {
        [cursorField]: nextPage,
      });

      await (env as any).SCHEDULER_QUEUE.send({
        ...message,
        cursor: nextPage,
      });
    } else {
      await updateBackfillState(repository_key, {
        [cursorField]: null,
        status: entity_type === "projects" ? "completed" : "in_progress",
      });

      if (entity_type !== "projects") {
        const nextEntityType = getNextEntityType(entity_type);
        if (nextEntityType) {
          await (env as any).SCHEDULER_QUEUE.send({
            type: "scheduler",
            repository_key,
            owner,
            repo,
            entity_type: nextEntityType,
          });
        } else {
          await updateBackfillState(repository_key, { status: "completed" });
        }
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    console.error(formatLog("[scheduler] Error processing:", { entity_type, repository_key, owner, repo, error: errorMsg, stack: errorStack }));
    await updateBackfillState(repository_key, {
      status: "paused_on_error",
      error_message: errorMsg,
      error_details: errorStack,
    });
    throw error;
  }
}

function getNextEntityType(
  current: SchedulerJobMessage["entity_type"]
): SchedulerJobMessage["entity_type"] | null {
  const order: SchedulerJobMessage["entity_type"][] = [
    "issues",
    "pull_requests",
    "comments",
    "releases",
    "projects",
  ];
  const currentIndex = order.indexOf(current);
  return currentIndex < order.length - 1 ? order[currentIndex + 1] : null;
}

