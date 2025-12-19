import type {
  Plugin,
  Document,
  IndexingHookContext,
  QueryHookContext,
} from "../types";

function normalizeNamespace(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

function getClientWorkspacePaths(context: QueryHookContext): string[] {
  const out: string[] = [];
  const clientContext = context.clientContext ?? {};

  const cwd = (clientContext as any)?.cwd;
  if (typeof cwd === "string" && cwd.trim().length > 0) {
    out.push(cwd.trim());
  }

  const roots = (clientContext as any)?.workspaceRoots;
  if (Array.isArray(roots)) {
    for (const root of roots) {
      if (typeof root === "string" && root.trim().length > 0) {
        out.push(root.trim());
      }
    }
  }

  return out;
}

function inferProjectFromPaths(paths: string[]): "rwsdk" | "machinen" | null {
  for (const p of paths) {
    const lower = p.toLowerCase().replace(/\\/g, "/");
    if (lower.includes("/redwoodjs/sdk")) {
      return "rwsdk";
    }
    if (lower.includes("/redwoodjs/machinen")) {
      return "machinen";
    }
    if (
      lower.includes("/rw/sdk") ||
      lower.includes("/sdk/") ||
      lower.endsWith("/sdk") ||
      lower.includes("/rwsdk") ||
      lower.includes("/sdk_") ||
      lower.includes("redwoodsdk")
    ) {
      return "rwsdk";
    }
    if (lower.includes("machinen")) {
      return "machinen";
    }
  }
  return null;
}

function inferProjectFromCursorDocument(
  document: Document
): "rwsdk" | "machinen" | null {
  const sm = document.metadata.sourceMetadata ?? {};
  const rootsRaw = (sm as any)?.workspaceRoots;
  const roots = Array.isArray(rootsRaw)
    ? rootsRaw.filter((r: unknown): r is string => typeof r === "string")
    : [];

  let hasMachinen = false;
  let hasRwsdk = false;

  for (const root of roots) {
    const trimmed = root.trim();
    if (!trimmed) {
      continue;
    }
    const project = inferProjectFromPaths([trimmed]);
    if (!project) {
      return null;
    }
    if (project === "machinen") {
      hasMachinen = true;
    }
    if (project === "rwsdk") {
      hasRwsdk = true;
    }
  }

  if (hasMachinen) {
    return "machinen";
  }
  if (hasRwsdk) {
    return "rwsdk";
  }
  return null;
}

function inferProjectFromGithubDocument(
  document: Document
): "rwsdk" | "machinen" | null {
  const sm = document.metadata.sourceMetadata ?? {};
  const owner =
    typeof (sm as any)?.owner === "string" ? String((sm as any).owner) : "";
  const repo =
    typeof (sm as any)?.repo === "string" ? String((sm as any).repo) : "";

  if (owner.toLowerCase() !== "redwoodjs") {
    return null;
  }
  if (repo.toLowerCase() === "sdk") {
    return "rwsdk";
  }
  if (repo.toLowerCase() === "machinen") {
    return "machinen";
  }
  return null;
}

function inferProjectFromDiscordDocument(
  document: Document
): "rwsdk" | "machinen" | null {
  const sm = document.metadata.sourceMetadata ?? {};
  const guildID =
    typeof (sm as any)?.guildID === "string" ? String((sm as any).guildID) : "";
  const channelID =
    typeof (sm as any)?.channelID === "string"
      ? String((sm as any).channelID)
      : "";

  const machinenChannelIds = new Set<string>([]);
  const rwsdkChannelIds = new Set<string>([
    "1307974274145062912",
    "1449132150392750080",
    "1435702216315899948",
  ]);

  if (machinenChannelIds.has(channelID)) {
    return "machinen";
  }
  if (rwsdkChannelIds.has(channelID)) {
    return "rwsdk";
  }
  if (!guildID) {
    return null;
  }
  return null;
}

function namespaceForProject(project: "rwsdk" | "machinen" | null): string {
  if (project === "rwsdk") {
    return "redwood:rwsdk";
  }
  if (project === "machinen") {
    return "redwood:machinen";
  }
  return "redwood:internal";
}

export const redwoodScopeRouterPlugin: Plugin = {
  name: "redwood-scope-router",
  scoping: {
    computeMomentGraphNamespaceForIndexing(
      document: Document,
      context: IndexingHookContext
    ) {
      if (document.source === "cursor") {
        const project = inferProjectFromCursorDocument(document);
        const namespace = namespaceForProject(project);
        const rootsRaw = (document.metadata.sourceMetadata as any)
          ?.workspaceRoots;
        const roots = Array.isArray(rootsRaw)
          ? rootsRaw
              .filter((r: unknown): r is string => typeof r === "string")
              .slice(0, 3)
          : [];
        console.log("[scope-router] indexing", {
          r2Key: context.r2Key,
          source: document.source,
          documentId: document.id,
          project,
          namespace,
          workspaceRootsSample: roots,
        });
        return namespace;
      }
      if (document.source === "github") {
        const project = inferProjectFromGithubDocument(document);
        const namespace = namespaceForProject(project);
        const sm = document.metadata.sourceMetadata ?? {};
        console.log("[scope-router] indexing", {
          r2Key: context.r2Key,
          source: document.source,
          documentId: document.id,
          project,
          namespace,
          owner: (sm as any)?.owner ?? null,
          repo: (sm as any)?.repo ?? null,
        });
        return namespace;
      }
      if (document.source === "discord") {
        const project = inferProjectFromDiscordDocument(document);
        const namespace = namespaceForProject(project);
        const sm = document.metadata.sourceMetadata ?? {};
        console.log("[scope-router] indexing", {
          r2Key: context.r2Key,
          source: document.source,
          documentId: document.id,
          project,
          namespace,
          guildID: (sm as any)?.guildID ?? null,
          channelID: (sm as any)?.channelID ?? null,
          type: (sm as any)?.type ?? null,
        });
        return namespace;
      }

      const project = null;
      const namespace = namespaceForProject(project);
      console.log("[scope-router] indexing", {
        r2Key: context.r2Key,
        source: document.source,
        documentId: document.id,
        project,
        namespace,
      });
      return namespace;
    },
    computeMomentGraphNamespaceForQuery(context: QueryHookContext) {
      const paths = getClientWorkspacePaths(context);
      const project = inferProjectFromPaths(paths);
      const namespace = namespaceForProject(project);
      console.log("[scope-router] query", {
        queryPreview:
          typeof context.query === "string" ? context.query.slice(0, 120) : "",
        project,
        namespace,
        cwd: (context.clientContext as any)?.cwd ?? null,
        workspaceRootsCount: Array.isArray(
          (context.clientContext as any)?.workspaceRoots
        )
          ? (context.clientContext as any).workspaceRoots.length
          : 0,
      });
      return namespace;
    },
  },
};
