
import { type RequestInfo } from "rwsdk/worker";
import { env } from "cloudflare:workers";
import { getMoment } from "@/app/engine/databases/momentGraph";
import {
  getMomentGraphNamespacePrefixFromEnv,
  applyMomentGraphNamespacePrefixValue,
} from "@/app/engine/momentGraphNamespace";

export async function debugMomentHandler({ request }: RequestInfo) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const namespace = url.searchParams.get("namespace");
  const prefix = url.searchParams.get("prefix");

  if (!id) return Response.json({ error: "No id specified" });

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

  const moment = await getMoment(id, context);
  return Response.json({
    success: true,
    moment,
    effectiveNamespace,
    effectivePrefix
  });
}
