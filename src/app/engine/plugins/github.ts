import type {
  Plugin,
  Document,
  Chunk,
  ChunkMetadata,
  IndexingHookContext,
  QueryHookContext,
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
          github_id: prIssueData.github_id,
          number: prIssueData.number,
          state: prIssueData.state,
          owner: parsed.owner,
          repo: parsed.repo,
          _rawJson: prIssueData,
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
          github_id: projectData.github_id,
          number: projectData.number,
          state: projectData.state,
          owner: parsed.owner,
          _rawJson: projectData,
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
          id: `${context.r2Key}#body`,
          documentId: context.r2Key,
          source: "github",
          content: data.body,
          metadata: {
            chunkId: `${context.r2Key}#body`,
            documentId: context.r2Key,
            source: "github",
            type:
              parsed.type === "pull-requests"
                ? "pull-request-body"
                : "issue-body",
            documentTitle: data.title,
            author: data.author,
            jsonPath: "$.body",
            github_id: data.github_id,
            number: data.number,
            state: data.state,
          },
        });
      }

      if (data.comments) {
        for (let i = 0; i < data.comments.length; i++) {
          const comment = data.comments[i];
          chunks.push({
            id: `${context.r2Key}#comment-${comment.id}`,
            documentId: context.r2Key,
            source: "github",
            content: comment.body,
            metadata: {
              chunkId: `${context.r2Key}#comment-${comment.id}`,
              documentId: context.r2Key,
              source: "github",
              type:
                parsed.type === "pull-requests"
                  ? "pull-request-comment"
                  : "issue-comment",
              documentTitle: data.title,
              author: comment.author,
              jsonPath: `$.comments[${i}].body`,
              github_id: data.github_id,
              number: data.number,
              comment_id: comment.id,
              created_at: comment.created_at,
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
          id: `${context.r2Key}#body`,
          documentId: context.r2Key,
          source: "github",
          content: data.body,
          metadata: {
            chunkId: `${context.r2Key}#body`,
            documentId: context.r2Key,
            source: "github",
            type: "project-body",
            documentTitle: data.title,
            author: data.owner,
            jsonPath: "$.body",
            github_id: data.github_id,
            number: data.number,
            state: data.state,
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
            id: `${context.r2Key}#item-${item.id}`,
            documentId: context.r2Key,
            source: "github",
            content,
            metadata: {
              chunkId: `${context.r2Key}#item-${item.id}`,
              documentId: context.r2Key,
              source: "github",
              type: "project-item",
              documentTitle: data.title,
              author: data.owner,
              jsonPath: `$.items[${i}]`,
              github_id: data.github_id,
              number: data.number,
              content_id: item.content_id,
              content_type: item.content_type,
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
    return {
      source: "github",
    };
  },

  async composeLlmPrompt(
    chunks: ChunkMetadata[],
    query: string,
    context: QueryHookContext,
    existingPrompt?: string
  ): Promise<string> {
    const githubChunks = chunks.filter((chunk) => chunk.source === "github");
    if (githubChunks.length === 0) {
      return existingPrompt || "";
    }

    const documentMap = new Map<
      string,
      GitHubLatestJson | GitHubProjectLatestJson
    >();
    const chunksByDocument = new Map<string, ChunkMetadata[]>();

    for (const chunk of githubChunks) {
      if (!chunk.documentId) {
        continue;
      }
      if (!chunksByDocument.has(chunk.documentId)) {
        chunksByDocument.set(chunk.documentId, []);
      }
      chunksByDocument.get(chunk.documentId)!.push(chunk);
    }

    for (const [documentId] of chunksByDocument) {
      const bucket = context.env.MACHINEN_BUCKET;
      const object = await bucket.get(documentId);
      if (object) {
        const jsonText = await object.text();
        const data = JSON.parse(jsonText);
        documentMap.set(documentId, data);
      }
    }

    const sections: string[] = [];

    for (const [documentId, docChunks] of chunksByDocument) {
      const document = documentMap.get(documentId);
      if (!document) {
        continue;
      }

      const parsed = parseR2Key(documentId);
      if (!parsed) {
        continue;
      }

      const docSections: string[] = [];

      if ("repo" in parsed) {
        const prIssueDoc = document as GitHubLatestJson;
        const typeLabel =
          parsed.type === "pull-requests" ? "Pull Request" : "Issue";
        const url = prIssueDoc.url || buildGitHubUrl(parsed);
        docSections.push(
          `## ${typeLabel} #${prIssueDoc.number}: ${prIssueDoc.title}`
        );
        docSections.push(`**URL:** ${url}`);
        docSections.push(`**Author:** @${prIssueDoc.author}`);
        docSections.push(`**State:** ${prIssueDoc.state}`);

        for (const chunk of docChunks) {
          if (!chunk.jsonPath) {
            continue;
          }
          const content = extractJsonPath(document, chunk.jsonPath);
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
              docSections.push(
                `\n**Comment by @${commentAuthor}:**\n${content}`
              );
            }
          }
        }
      } else {
        const projectDoc = document as GitHubProjectLatestJson;
        docSections.push(`## Project: ${projectDoc.title}`);
        const url = buildGitHubUrl(parsed);
        docSections.push(`**URL:** ${url}`);
        docSections.push(`**Owner:** ${projectDoc.owner}`);
        docSections.push(`**State:** ${projectDoc.state}`);

        for (const chunk of docChunks) {
          if (!chunk.jsonPath) {
            continue;
          }
          const content = extractJsonPath(document, chunk.jsonPath);
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

      sections.push(docSections.join("\n"));
    }

    const contextSection = sections.join("\n\n---\n\n");

    if (existingPrompt) {
      return `${existingPrompt}\n\n## Context\n\n${contextSection}`;
    }

    return `You are a helpful assistant answering questions based on GitHub content.

## User Query
${query}

## Context
${contextSection}

Please answer the user's query based on the context provided above.`;
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
