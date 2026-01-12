import { env } from "cloudflare:workers";
import {
  getBackfillState,
  incrementBackfillEnqueuedCount,
  markBackfillEnqueueCompleted,
  updateBackfillState,
} from "./backfill-state";
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

async function fetchGitHubProjectsGraphQL(
  organizationLogin: string,
  cursor?: string
): Promise<{ data: any[]; nextPage?: string }> {
  const token = (env as any).GITHUB_TOKEN as string | undefined;
  if (!token) {
    console.error("[scheduler] GITHUB_TOKEN is not set");
    throw new Error("GITHUB_TOKEN is not set");
  }

  const query = `
    query($org: String!, $cursor: String) {
      organization(login: $org) {
        projectsV2(first: 100, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            title
            shortDescription
            public
            closed
            createdAt
            updatedAt
            number
          }
        }
      }
    }
  `;

  const variables = {
    org: organizationLogin,
    cursor: cursor || null,
  };

  console.log(
    formatLog("[scheduler] Fetching GitHub Projects via GraphQL:", {
      organization: organizationLogin,
      cursor: cursor || "none",
    })
  );

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "machinen-github-ingestor/1.0",
    },
    body: JSON.stringify({ query, variables }),
  });

  console.log(
    formatLog("[scheduler] GitHub GraphQL response:", {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
    })
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error(
      formatLog("[scheduler] GitHub GraphQL error:", {
        status: response.status,
        statusText: response.statusText,
        errorBody: errorText,
      })
    );
    throw new Error(
      `GitHub GraphQL error: ${response.status} ${
        response.statusText
      } | Body: ${errorText.substring(0, 500)}`
    );
  }

  const result = (await response.json()) as {
    data?: {
      organization?: {
        projectsV2?: {
          pageInfo?: {
            hasNextPage: boolean;
            endCursor: string | null;
          };
          nodes: any[];
        };
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (result.errors) {
    const errorMessages = result.errors.map((e) => e.message).join(", ");
    console.error(
      formatLog("[scheduler] GitHub GraphQL query errors:", {
        errors: result.errors,
      })
    );
    throw new Error(`GitHub GraphQL query errors: ${errorMessages}`);
  }

  const projects = result.data?.organization?.projectsV2?.nodes || [];
  const pageInfo = result.data?.organization?.projectsV2?.pageInfo;
  const nextPage = pageInfo?.hasNextPage ? pageInfo.endCursor : undefined;

  // Transform GraphQL response to match expected format
  const transformedProjects = projects.map((project: any) => ({
    id: project.id,
    number: project.number,
    title: project.title,
    body: project.shortDescription || null,
    state: project.closed === true ? "closed" : "open",
    created_at: project.createdAt,
    updated_at: project.updatedAt,
    owner: {
      login: organizationLogin,
      type: "Organization",
    },
  }));

  return { data: transformedProjects, nextPage: nextPage || undefined };
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

  const fullUrl = page
    ? `${url}?per_page=100&page=${page}`
    : `${url}?per_page=100`;
  console.log(
    formatLog("[scheduler] Fetching GitHub API:", {
      url: fullUrl,
      hasToken: !!token,
      tokenLength: token.length,
      tokenPrefix: token.substring(0, 4),
    })
  );

  const response = await fetch(fullUrl, {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "machinen-github-ingestor/1.0",
    },
  });

  console.log(
    formatLog("[scheduler] GitHub API response:", {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
    })
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error(
      formatLog("[scheduler] GitHub API error:", {
        status: response.status,
        statusText: response.statusText,
        url: fullUrl,
        errorBody: errorText,
      })
    );
    throw new Error(
      `GitHub API error: ${response.status} ${
        response.statusText
      } | URL: ${fullUrl} | Body: ${errorText.substring(0, 500)}`
    );
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

export async function processSchedulerJob(
  message: SchedulerJobMessage
): Promise<void> {
  const { repository_key, owner, repo, entity_type, cursor, backfill_run_id } =
    message;

  console.log(
    formatLog("[scheduler] Processing scheduler job:", {
      repository_key,
      owner,
      repo,
      entity_type,
      cursor,
      backfill_run_id: backfill_run_id ?? null,
    })
  );

  const state = await getBackfillState(repository_key);
  console.log(formatLog("[scheduler] Current backfill state:", state));
  const runId = backfill_run_id ?? state?.current_run_id ?? null;

  if (state?.status === "paused_on_error" || state?.status === "paused") {
    console.log(
      `[scheduler] Backfill paused for ${repository_key} (status: ${state.status}), skipping`
    );
    return;
  }

  const isTestRun = state?.test_run ?? false;
  console.log(`[scheduler] Test run mode: ${isTestRun}`);

  await updateBackfillState(repository_key, { status: "in_progress" });

  try {
    let url: string;
    let cursorField:
      | "issues_cursor"
      | "pull_requests_cursor"
      | "comments_cursor"
      | "releases_cursor"
      | "projects_cursor";

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
        // Projects v2 uses GraphQL API, not REST API
        cursorField = "projects_cursor";
        const projectsResult = await fetchGitHubProjectsGraphQL(owner, cursor);
        const projectsData = projectsResult.data;
        const projectsNextPage = projectsResult.nextPage;

        console.log(
          formatLog("[scheduler] Fetched projects data:", {
            entityType: entity_type,
            count: projectsData.length,
            hasNextPage: !!projectsNextPage,
            nextPage: projectsNextPage,
          })
        );

        const projectsProcessorQueue = (env as any).PROCESSOR_QUEUE as Queue;

        console.log(
          formatLog("[scheduler] Enqueueing processor jobs:", {
            count: projectsData.length,
            entityType: entity_type,
          })
        );

        for (const project of projectsData) {
          await projectsProcessorQueue.send({
            type: "processor",
            repository_key,
            owner,
            repo: "_projects",
            entity_type: "project",
            entity_data: project,
            event_type: "backfill",
            moment_graph_namespace_prefix:
              state?.moment_graph_namespace_prefix ?? null,
            ...(runId ? { backfill_run_id: runId } : {}),
          });
        }

        if (runId) {
          await incrementBackfillEnqueuedCount(
            repository_key,
            runId,
            projectsData.length
          );
        }

        console.log(
          formatLog("[scheduler] Enqueued all processor jobs:", {
            count: projectsData.length,
            entityType: entity_type,
          })
        );

        if (isTestRun) {
          console.log(
            `[scheduler] Test run complete for ${repository_key} - processed first page of ${entity_type}`
          );
          await updateBackfillState(repository_key, {
            status: "completed",
            [cursorField]: null,
          });
          return;
        }

        if (projectsNextPage) {
          await updateBackfillState(repository_key, {
            [cursorField]: projectsNextPage,
          });

          await (env as any).SCHEDULER_QUEUE.send({
            ...message,
            cursor: projectsNextPage,
            ...(runId ? { backfill_run_id: runId } : {}),
          });
        } else {
          await updateBackfillState(repository_key, {
            [cursorField]: null,
            status: "in_progress",
          });

          const nextEntityType = getNextEntityType(entity_type);
          if (nextEntityType) {
            await (env as any).SCHEDULER_QUEUE.send({
              type: "scheduler",
              repository_key,
              owner,
              repo,
              entity_type: nextEntityType,
              ...(runId ? { backfill_run_id: runId } : {}),
            });
          } else {
            await updateBackfillState(repository_key, { status: "completed" });

            if (runId) {
              await markBackfillEnqueueCompleted(repository_key, runId);
              const updated = await getBackfillState(repository_key);
              console.log("[backfill] enqueue completed", {
                repositoryKey: repository_key,
                backfillRunId: runId,
                momentGraphNamespacePrefix:
                  updated?.moment_graph_namespace_prefix ?? null,
                enqueuedCount: updated?.enqueued_count ?? 0,
              });
            }
          }
        }
        return;
      default:
        throw new Error(`Unknown entity type: ${entity_type}`);
    }

    const { data, nextPage } = await fetchGitHubPage(url, cursor);

    console.log(
      formatLog("[scheduler] Fetched data:", {
        entityType: entity_type,
        count: data.length,
        hasNextPage: !!nextPage,
        nextPage,
      })
    );

    const processorQueue = (env as any).PROCESSOR_QUEUE as Queue;

    console.log(
      formatLog("[scheduler] Enqueueing processor jobs:", {
        count: data.length,
        entityType: entity_type,
      })
    );

    let enqueued = 0;
    for (const entity of data) {
      if (
        entity_type === "issues" &&
        entity &&
        typeof entity === "object" &&
        (entity as any).pull_request
      ) {
        continue;
      }
      await processorQueue.send({
        type: "processor",
        repository_key,
        owner,
        repo,
        entity_type:
          entity_type === "pull_requests"
            ? "pull_request"
            : (entity_type.slice(0, -1) as any),
        entity_data: entity,
        event_type: "backfill",
        moment_graph_namespace_prefix:
          state?.moment_graph_namespace_prefix ?? null,
        ...(runId ? { backfill_run_id: runId } : {}),
      });
      enqueued += 1;
    }

    if (runId) {
      await incrementBackfillEnqueuedCount(repository_key, runId, enqueued);
    }

    console.log(
      formatLog("[scheduler] Enqueued all processor jobs:", {
        count: enqueued,
        entityType: entity_type,
      })
    );

    if (isTestRun) {
      console.log(
        `[scheduler] Test run complete for ${repository_key} - processed first page of ${entity_type}`
      );
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
        ...(runId ? { backfill_run_id: runId } : {}),
      });
    } else {
      await updateBackfillState(repository_key, {
        [cursorField]: null,
        status: "in_progress",
      });

      const nextEntityType = getNextEntityType(entity_type);
      if (nextEntityType) {
        await (env as any).SCHEDULER_QUEUE.send({
          type: "scheduler",
          repository_key,
          owner,
          repo,
          entity_type: nextEntityType,
          ...(runId ? { backfill_run_id: runId } : {}),
        });
      } else {
        await updateBackfillState(repository_key, { status: "completed" });

        if (runId) {
          await markBackfillEnqueueCompleted(repository_key, runId);
          const updated = await getBackfillState(repository_key);
          console.log("[backfill] enqueue completed", {
            repositoryKey: repository_key,
            backfillRunId: runId,
            momentGraphNamespacePrefix:
              updated?.moment_graph_namespace_prefix ?? null,
            enqueuedCount: updated?.enqueued_count ?? 0,
          });
        }
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    console.error(
      formatLog("[scheduler] Error processing:", {
        entity_type,
        repository_key,
        owner,
        repo,
        error: errorMsg,
        stack: errorStack,
      })
    );
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
