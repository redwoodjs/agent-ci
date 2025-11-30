import type {
  Plugin,
  Document,
  Chunk,
  ChunkMetadata,
  IndexingHookContext,
  QueryHookContext,
  ReconstructedContext,
} from "../types";

interface GitHubLatestJson {
  github_id: number;
  number: number;
  state: string;
  author: string;
  created_at: string;
  updated_at: string;
  title: string;
  body: string;
  comments?: Array<{
    id: number;
    body: string;
    author: string;
    created_at: string;
    updated_at?: string;
  }>;
  url?: string;
  [key: string]: unknown;
}

interface GitHubProjectLatestJson {
  github_id: string;
  number?: number;
  state: "open" | "closed" | "deleted";
  owner: string;
  owner_type: string;
  created_at: string;
  updated_at: string;
  title: string;
  body: string | null;
  items?: Array<{
    id: string;
    content_id?: number;
    content_type: "Issue" | "PullRequest" | "DraftIssue";
    title?: string;
    field_values?: Array<{
      name: string;
      value: string | number | null;
    }>;
  }>;
  [key: string]: unknown;
}

function isGitHubR2Key(r2Key: string): boolean {
  return (
    r2Key.startsWith("github/") &&
    r2Key.endsWith("/latest.json") &&
    (r2Key.includes("/pull-requests/") ||
      r2Key.includes("/issues/") ||
      r2Key.includes("/projects/"))
  );
}

function parseR2Key(r2Key: string):
  | {
      owner: string;
      repo: string;
      type: "pull-requests" | "issues";
      number: number;
    }
  | {
      owner: string;
      type: "projects";
      number: number;
    }
  | null {
  const prIssueMatch = r2Key.match(
    /^github\/([^\/]+)\/([^\/]+)\/(pull-requests|issues)\/(\d+)\/latest\.json$/
  );
  if (prIssueMatch) {
    return {
      owner: prIssueMatch[1],
      repo: prIssueMatch[2],
      type: prIssueMatch[3] as "pull-requests" | "issues",
      number: parseInt(prIssueMatch[4], 10),
    };
  }

  const projectMatch = r2Key.match(
    /^github\/([^\/]+)\/projects\/(\d+)\/latest\.json$/
  );
  if (projectMatch) {
    return {
      owner: projectMatch[1],
      type: "projects",
      number: parseInt(projectMatch[2], 10),
    };
  }

  return null;
}

function buildGitHubUrl(
  parsed:
    | {
        owner: string;
        repo: string;
        type: "pull-requests" | "issues";
        number: number;
      }
    | { owner: string; type: "projects"; number: number }
): string {
  if ("repo" in parsed) {
    return `https://github.com/${parsed.owner}/${parsed.repo}/${
      parsed.type === "pull-requests" ? "pull" : "issues"
    }/${parsed.number}`;
  }
  return `https://github.com/orgs/${parsed.owner}/projects/${parsed.number}`;
}

export const githubPlugin: Plugin = {
  name: "github",

  async prepareSourceDocument(
    context: IndexingHookContext
  ): Promise<Document | null> {
    if (!isGitHubR2Key(context.r2Key)) {
      return null;
    }

    const parsed = parseR2Key(context.r2Key);
    if (!parsed) {
      return null;
    }

    const bucket = context.env.MACHINEN_BUCKET;
    const object = await bucket.get(context.r2Key);

    if (!object) {
      throw new Error(`R2 object not found: ${context.r2Key}`);
    }

    const jsonText = await object.text();
    const data = JSON.parse(jsonText);

    if ("repo" in parsed) {
      const prIssueData = data as GitHubLatestJson;
      const url = prIssueData.url || buildGitHubUrl(parsed);

      return {
        id: context.r2Key,
        source: "github",
        type: parsed.type === "pull-requests" ? "pull-request" : "issue",
        content: prIssueData.body || "",
        metadata: {
          title: prIssueData.title,
          url,
          createdAt: prIssueData.created_at,
          author: prIssueData.author,
          _rawJson: prIssueData,
          sourceMetadata: {
            type: "github-pr-issue",
            owner: parsed.owner,
            repo: parsed.repo,
            number: parsed.number,
          },
        },
      };
    } else {
      const projectData = data as GitHubProjectLatestJson;
      const url = buildGitHubUrl(parsed);

      return {
        id: context.r2Key,
        source: "github",
        type: "project",
        content: projectData.body || "",
        metadata: {
          title: projectData.title,
          url,
          createdAt: projectData.created_at,
          author: projectData.owner,
          _rawJson: projectData,
          sourceMetadata: {
            type: "github-project",
            owner: parsed.owner,
            number: parsed.number,
          },
        },
      };
    }
  },

  async splitDocumentIntoChunks(
    document: Document,
    context: IndexingHookContext
  ): Promise<Chunk[]> {
    if (document.source !== "github") {
      return [];
    }

    const parsed = parseR2Key(context.r2Key);
    if (!parsed) {
      return [];
    }

    const chunks: Chunk[] = [];

    if ("repo" in parsed) {
      const data = document.metadata._rawJson as GitHubLatestJson | undefined;
      if (!data) {
        throw new Error(
          `Document metadata missing _rawJson for ${context.r2Key}`
        );
      }

      if (data.body) {
        chunks.push({
          id: `${document.id}#body`,
          documentId: document.id,
          source: "github",
          content: data.body,
          metadata: {
            ...document.metadata,
            chunkId: `${document.id}#body`,
            documentId: document.id,
            source: "github",
            type: "issue-body",
            documentTitle: document.metadata.title,
            author: document.metadata.author,
            jsonPath: "$.body",
            subjectId: document.subjectId,
          },
        });
      } else if (data.title) {
        chunks.push({
          id: `${document.id}#title`,
          documentId: document.id,
          source: "github",
          content: data.title,
          metadata: {
            ...document.metadata,
            chunkId: `${document.id}#title`,
            documentId: document.id,
            source: "github",
            type:
              parsed.type === "pull-requests"
                ? "pull-request-title"
                : "issue-title",
            documentTitle: data.title,
            author: data.author,
            jsonPath: "$.title",
            subjectId: document.subjectId,
          },
        });
      }

      if (data.comments) {
        for (let i = 0; i < data.comments.length; i++) {
          const comment = data.comments[i];
          chunks.push({
            id: `${document.id}#comment-${comment.id}`,
            documentId: document.id,
            source: "github",
            content: comment.body,
            metadata: {
              ...document.metadata,
              chunkId: `${document.id}#comment-${comment.id}`,
              documentId: document.id,
              source: "github",
              type:
                parsed.type === "pull-requests"
                  ? "pull-request-comment"
                  : "issue-comment",
              documentTitle: data.title,
              author: comment.author,
              jsonPath: `$.comments[${i}].body`,
              subjectId: document.subjectId,
            },
          });
        }
      }
    } else {
      const data = document.metadata._rawJson as
        | GitHubProjectLatestJson
        | undefined;
      if (!data) {
        throw new Error(
          `Document metadata missing _rawJson for ${context.r2Key}`
        );
      }

      if (data.body) {
        chunks.push({
          id: `${document.id}#body`,
          documentId: document.id,
          source: "github",
          content: data.body,
          metadata: {
            ...document.metadata,
            chunkId: `${document.id}#body`,
            documentId: document.id,
            source: "github",
            type: "project-body",
            documentTitle: data.title,
            author: data.owner,
            jsonPath: "$.body",
            subjectId: document.subjectId,
          },
        });
      } else if (data.title) {
        chunks.push({
          id: `${document.id}#title`,
          documentId: document.id,
          source: "github",
          content: data.title,
          metadata: {
            ...document.metadata,
            chunkId: `${document.id}#title`,
            documentId: document.id,
            source: "github",
            type: "project-title",
            documentTitle: data.title,
            author: data.owner,
            jsonPath: "$.title",
            subjectId: document.subjectId,
          },
        });
      }

      if (data.items) {
        for (let i = 0; i < data.items.length; i++) {
          const item = data.items[i];
          const fieldValuesText =
            item.field_values
              ?.map((fv) => `${fv.name}: ${fv.value ?? "null"}`)
              .join(", ") || "";
          const content = item.title
            ? `${item.title}${fieldValuesText ? ` - ${fieldValuesText}` : ""}`
            : `${item.content_type}${
                item.content_id ? ` #${item.content_id}` : ""
              }${fieldValuesText ? ` - ${fieldValuesText}` : ""}`;

          chunks.push({
            id: `${document.id}#item-${item.id}`,
            documentId: document.id,
            source: "github",
            content,
            metadata: {
              ...document.metadata,
              chunkId: `${document.id}#item-${item.id}`,
              documentId: document.id,
              source: "github",
              type: "project-item",
              documentTitle: data.title,
              author: data.owner,
              jsonPath: `$.items[${i}]`,
              subjectId: document.subjectId,
            },
          });
        }
      }
    }

    return chunks;
  },

  async buildVectorSearchFilter(
    context: QueryHookContext
  ): Promise<Record<string, unknown> | null> {
    return null;
  },

  async reconstructContext(
    documentChunks: ChunkMetadata[],
    sourceDocument: GitHubLatestJson | GitHubProjectLatestJson,
    context: QueryHookContext
  ): Promise<ReconstructedContext | null> {
    if (documentChunks.length === 0) {
      return null;
    }

    const firstChunk = documentChunks[0];
    const sourceMetadata = firstChunk.sourceMetadata;

    if (!sourceMetadata || firstChunk.source !== "github") {
      return null;
    }

    const docSections: string[] = [];

    if (sourceMetadata.type === "github-pr-issue") {
      const prIssueDoc = sourceDocument as GitHubLatestJson;
      const typeLabel =
        sourceMetadata.type === "pull-requests" ? "Pull Request" : "Issue";
      const url =
        prIssueDoc.url ||
        `https://github.com/${sourceMetadata.owner}/${sourceMetadata.repo}/${
          typeLabel === "Pull Request" ? "pull" : "issues"
        }/${sourceMetadata.number}`;
      docSections.push(
        `## ${typeLabel} #${prIssueDoc.number}: ${prIssueDoc.title}`
      );
      docSections.push(`**URL:** ${url}`);
      docSections.push(`**Author:** @${prIssueDoc.author}`);
      docSections.push(`**State:** ${prIssueDoc.state}`);

      for (const chunk of documentChunks) {
        if (!chunk.jsonPath) {
          continue;
        }
        const content = extractJsonPath(sourceDocument, chunk.jsonPath);
        if (content) {
          if (
            chunk.type === "pull-request-body" ||
            chunk.type === "issue-body"
          ) {
            docSections.push(`\n**Description:**\n${content}`);
          } else if (
            chunk.type === "pull-request-comment" ||
            chunk.type === "issue-comment"
          ) {
            const commentAuthor = chunk.author || "unknown";
            docSections.push(`\n**Comment by @${commentAuthor}:**\n${content}`);
          }
        }
      }
    } else if (sourceMetadata.type === "github-project") {
      const projectDoc = sourceDocument as GitHubProjectLatestJson;
      docSections.push(`## Project: ${projectDoc.title}`);
      const url = `https://github.com/orgs/${sourceMetadata.owner}/projects/${sourceMetadata.number}`;
      docSections.push(`**URL:** ${url}`);
      docSections.push(`**Owner:** ${projectDoc.owner}`);
      docSections.push(`**State:** ${projectDoc.state}`);

      for (const chunk of documentChunks) {
        if (!chunk.jsonPath) {
          continue;
        }
        const content = extractJsonPath(sourceDocument, chunk.jsonPath);
        if (content) {
          if (chunk.type === "project-body") {
            docSections.push(`\n**Description:**\n${content}`);
          } else if (chunk.type === "project-item") {
            try {
              const item = JSON.parse(content);
              const fieldValuesText =
                item.field_values
                  ?.map(
                    (fv: { name: string; value: unknown }) =>
                      `${fv.name}: ${fv.value ?? "null"}`
                  )
                  .join(", ") || "";
              const itemTitle =
                item.title ||
                `${item.content_type}${
                  item.content_id ? ` #${item.content_id}` : ""
                }`;
              docSections.push(
                `\n**Project Item:** ${itemTitle}${
                  fieldValuesText ? ` (${fieldValuesText})` : ""
                }`
              );
            } catch {
              docSections.push(`\n**Project Item:**\n${content}`);
            }
          }
        }
      }
    }

    const content = docSections.join("\n");

    return {
      content,
      source: "github",
      primaryMetadata: firstChunk,
    };
  },

  async composeLlmPrompt(
    contexts: ReconstructedContext[],
    query: string,
    context: QueryHookContext
  ): Promise<string> {
    const githubContexts = contexts.filter((ctx) => ctx.source === "github");
    if (githubContexts.length === 0) {
      return "";
    }

    const contextSection = githubContexts
      .map((ctx) => ctx.content)
      .join("\n\n---\n\n");

    return `## GitHub Context\n\n${contextSection}`;
  },
};

function extractJsonPath(obj: unknown, jsonPath: string): string | null {
  if (!jsonPath.startsWith("$.")) {
    return null;
  }

  const path = jsonPath.slice(2);
  const parts = path.split(/[\.\[\]]/).filter((p) => p !== "");

  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) {
      return null;
    }
    if (typeof current !== "object") {
      return null;
    }
    if (Array.isArray(current)) {
      const index = parseInt(part, 10);
      if (isNaN(index)) {
        return null;
      }
      current = current[index];
    } else {
      current = (current as Record<string, unknown>)[part];
    }
  }

  if (typeof current === "string") {
    return current;
  }
  if (typeof current === "object" && current !== null) {
    return JSON.stringify(current);
  }
  return String(current);
}
