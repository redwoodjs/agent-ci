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

export async function fetchGitHubProject(
  projectId: string
): Promise<{
  id: string;
  number: number;
  title: string;
  shortDescription: string | null;
  public: boolean;
  closed: boolean;
  createdAt: string;
  updatedAt: string;
  owner: {
    login: string;
    type: string;
  };
}> {
  const token = (env as any).GITHUB_TOKEN as string | undefined;
  if (!token) {
    throw new Error("GITHUB_TOKEN is not set");
  }

  const query = `
    query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          id
          title
          shortDescription
          public
          closed
          createdAt
          updatedAt
          number
          owner {
            ... on Organization {
              login
              __typename
            }
            ... on User {
              login
              __typename
            }
          }
        }
      }
    }
  `;

  const variables = {
    projectId,
  };

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "machinen-github-ingestor/1.0",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `GitHub GraphQL error: ${response.status} ${response.statusText} | Body: ${errorText.substring(0, 500)}`
    );
  }

  const result = (await response.json()) as {
    data?: {
      node?: {
        id: string;
        title: string;
        shortDescription: string | null;
        public: boolean;
        closed: boolean;
        createdAt: string;
        updatedAt: string;
        number: number;
        owner: {
          login: string;
          __typename: string;
        };
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (result.errors) {
    const errorMessages = result.errors.map((e) => e.message).join(", ");
    throw new Error(`GitHub GraphQL query errors: ${errorMessages}`);
  }

  const project = result.data?.node;
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }

  return {
    id: project.id,
    number: project.number,
    title: project.title,
    shortDescription: project.shortDescription,
    public: project.public,
    closed: project.closed,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    owner: {
      login: project.owner.login,
      type: project.owner.__typename === "Organization" ? "Organization" : "User",
    },
  };
}

export interface GitHubComment {
  id: number;
  body: string;
  created_at: string;
  updated_at: string;
  user: {
    login: string;
    avatar_url?: string;
  };
  issue_url?: string;
  pull_request_url?: string;
  pull_request_review_id?: number;
}

export async function fetchIssueComments(
  owner: string,
  repo: string,
  issueNumber: number
): Promise<GitHubComment[]> {
  return fetchGitHubEntity<GitHubComment[]>(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`
  );
}

export async function fetchPullRequestComments(
  owner: string,
  repo: string,
  prNumber: number
): Promise<GitHubComment[]> {
  return fetchGitHubEntity<GitHubComment[]>(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments`
  );
}

export interface GitHubProjectItem {
  id: string;
  content_node_id?: string;
  content_id?: number;
  content_type: "Issue" | "PullRequest" | "DraftIssue";
  field_values?: Array<{
    field_node_id: string;
    name: string;
    value: string | number | null;
  }>;
  created_at: string;
  updated_at: string;
}

export async function fetchProjectItems(
  projectId: string
): Promise<GitHubProjectItem[]> {
  const token = (env as any).GITHUB_TOKEN as string | undefined;
  if (!token) {
    throw new Error("GITHUB_TOKEN is not set");
  }

  const query = `
    query($projectId: ID!, $first: Int!, $after: String) {
      node(id: $projectId) {
        ... on ProjectV2 {
          items(first: $first, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              content {
                ... on Issue {
                  id
                  number
                }
                ... on PullRequest {
                  id
                  number
                }
              }
              fieldValues(first: 20) {
                nodes {
                  ... on ProjectV2ItemFieldTextValue {
                    field {
                      ... on ProjectV2Field {
                        id
                        name
                      }
                    }
                    text
                  }
                  ... on ProjectV2ItemFieldNumberValue {
                    field {
                      ... on ProjectV2Field {
                        id
                        name
                      }
                    }
                    number
                  }
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    field {
                      ... on ProjectV2Field {
                        id
                        name
                      }
                    }
                    name
                  }
                  ... on ProjectV2ItemFieldDateValue {
                    field {
                      ... on ProjectV2Field {
                        id
                        name
                      }
                    }
                    date
                  }
                }
              }
              createdAt
              updatedAt
            }
          }
        }
      }
    }
  `;

  const items: GitHubProjectItem[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const variables: {
      projectId: string;
      first: number;
      after?: string;
    } = {
      projectId,
      first: 100,
    };
    if (cursor) {
      variables.after = cursor;
    }

    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "machinen-github-ingestor/1.0",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `GitHub GraphQL error: ${response.status} ${response.statusText} | Body: ${errorText.substring(0, 500)}`
      );
    }

    const result = (await response.json()) as {
      data?: {
        node?: {
          items?: {
            pageInfo: {
              hasNextPage: boolean;
              endCursor: string | null;
            };
            nodes: Array<{
              id: string;
              content?: {
                id?: string;
                number?: number;
              } | null;
              fieldValues: {
                nodes: Array<{
                  field?: {
                    id?: string;
                    name?: string;
                  };
                  text?: string;
                  number?: number;
                  name?: string;
                  date?: string;
                }>;
              };
              createdAt: string;
              updatedAt: string;
            }>;
          };
        };
      };
      errors?: Array<{ message: string }>;
    };

    if (result.errors) {
      const errorMessages = result.errors.map((e) => e.message).join(", ");
      throw new Error(`GitHub GraphQL query errors: ${errorMessages}`);
    }

    const project = result.data?.node;
    if (!project || !project.items) {
      break;
    }

    for (const node of project.items.nodes) {
      const contentId = node.content?.number;
      const contentType =
        node.content?.id?.startsWith("I_") || node.content?.id?.startsWith("PR_")
          ? node.content.id.startsWith("I_")
            ? "Issue"
            : "PullRequest"
          : "DraftIssue";

      const fieldValues = node.fieldValues.nodes
        .map((fv) => {
          const fieldName = fv.field?.name || "";
          let value: string | number | null = null;
          if (fv.text !== undefined) {
            value = fv.text;
          } else if (fv.number !== undefined) {
            value = fv.number;
          } else if (fv.name !== undefined) {
            value = fv.name;
          } else if (fv.date !== undefined) {
            value = fv.date;
          }

          return {
            field_node_id: fv.field?.id || "",
            name: fieldName,
            value,
          };
        })
        .filter((fv) => fv.name);

      items.push({
        id: node.id,
        content_node_id: node.content?.id,
        content_id: contentId,
        content_type: contentType as "Issue" | "PullRequest" | "DraftIssue",
        field_values: fieldValues.length > 0 ? fieldValues : undefined,
        created_at: node.createdAt,
        updated_at: node.updatedAt,
      });
    }

    hasNextPage = project.items.pageInfo.hasNextPage;
    cursor = project.items.pageInfo.endCursor;
  }

  return items;
}

