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

