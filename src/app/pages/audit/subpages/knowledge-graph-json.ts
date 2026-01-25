import { type RequestInfo } from "rwsdk/worker";
import { env } from "cloudflare:workers";
import {
  getKnowledgeGraphStats,
  getDescendantsForRootSlim,
  getSubjectMoments,
  getAllMoments,
} from "@/app/engine/databases/momentGraph";
import {
  getMomentGraphNamespacePrefixFromEnv,
  applyMomentGraphNamespacePrefixValue,
} from "@/app/engine/momentGraphNamespace";

export async function knowledgeGraphJsonHandler({ request }: RequestInfo) {
  const url = new URL(request.url);
  const namespace = url.searchParams.get("namespace");
  const prefix = url.searchParams.get("prefix");
  const tab = url.searchParams.get("tab") || "subjects";
  const rootId = url.searchParams.get("rootId");

  const envCloudflare = env as Cloudflare.Env;
  const envPrefix = getMomentGraphNamespacePrefixFromEnv(envCloudflare);
  const effectivePrefix = prefix || envPrefix;
  const effectiveNamespace = applyMomentGraphNamespacePrefixValue(
    namespace,
    effectivePrefix
  );

  const context = {
    env: envCloudflare,
    momentGraphNamespace: effectiveNamespace,
  };

  const [stats, listData] = await Promise.all([
    getKnowledgeGraphStats(context),
    tab === "moments"
      ? getAllMoments(context, { limit: 1000 })
      : getSubjectMoments(context, { limit: 1000 }),
  ]);

  let graphData = null;
  let graphTruncated = false;

  if (rootId) {
    const descendants = await getDescendantsForRootSlim(rootId, context, {
      maxNodes: 5000,
    });
    graphData = descendants.nodes;
    graphTruncated = descendants.truncated;
  }

  return Response.json({
    success: true,
    effectiveNamespace,
    effectivePrefix,
    stats,
    tab,
    listData,
    graphData,
    graphTruncated,
    params: {
      namespace,
      prefix,
      tab,
      rootId,
    },
  });
}
