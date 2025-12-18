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
    const lower = p.toLowerCase();
    if (
      lower.includes("/rw/sdk") ||
      lower.includes("/sdk") ||
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
  const roots = (sm as any)?.workspaceRoots;
  if (Array.isArray(roots)) {
    const paths = roots.filter(
      (r: unknown): r is string => typeof r === "string"
    );
    const fromRoots = inferProjectFromPaths(paths);
    if (fromRoots) {
      return fromRoots;
    }
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
  const channelID =
    typeof (sm as any)?.channelID === "string"
      ? String((sm as any).channelID)
      : "";

  const machinenChannelIds = new Set<string>([]);
  const rwsdkChannelIds = new Set<string>([
    "1435702216315899948",
    "1307974274145062912",
  ]);

  if (machinenChannelIds.has(channelID)) {
    return "machinen";
  }
  if (rwsdkChannelIds.has(channelID)) {
    return "rwsdk";
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
        return namespaceForProject(inferProjectFromCursorDocument(document));
      }
      if (document.source === "github") {
        return namespaceForProject(inferProjectFromGithubDocument(document));
      }
      if (document.source === "discord") {
        return namespaceForProject(inferProjectFromDiscordDocument(document));
      }

      return namespaceForProject(null);
    },
    computeMomentGraphNamespaceForQuery(context: QueryHookContext) {
      const paths = getClientWorkspacePaths(context);
      const project = inferProjectFromPaths(paths);
      return namespaceForProject(project);
    },
  },
};
