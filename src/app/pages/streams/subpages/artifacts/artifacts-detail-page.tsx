import { env } from "cloudflare:workers";
import { Badge } from "@/app/components/ui/badge";
import { db } from "@/db";

export async function ArtifactDetailPage({
  params,
}: {
  params: { streamID: string; artifactID: string };
}) {
  const streamID = parseInt(params.streamID);
  const artifactID = parseInt(params.artifactID);

  const artifact = await db
    .selectFrom("artifacts")
    .innerJoin("sources", "sources.id", "artifacts.sourceID")
    .selectAll()
    .select(["sources.type as sourceType"])
    .where("artifacts.id", "=", artifactID)
    .executeTakeFirstOrThrow();

  let rawContent = "";
  if (artifact.sourceType === "transcripts") {
    const raw = await env.MACHINEN_BUCKET.get(artifact.bucketPath + "raw.md");
    const text = await raw?.text();
    if (text) {
      rawContent = text;
    }
  } else if (artifact.sourceType === "pull-requests") {
    const raw = await env.MACHINEN_BUCKET.get(artifact.bucketPath + "raw.json");
    const text = await raw?.text();
    if (text) {
      rawContent = JSON.stringify(JSON.parse(text), null, 2);
    }
  }

  //   const artifacts = await db
  //     .selectFrom("stream_artifacts")
  //     .where("streamID", "=", streamID)
  //     .innerJoin("artifacts", "artifacts.id", "stream_artifacts.artifactID")
  //     .innerJoin("sources", "sources.id", "artifacts.sourceID")
  //     .selectAll("artifacts")
  //     .select(["sources.type as sourceType", "stream_artifacts.score"])
  //     .execute();

  return (
    <div className="flex-1 p-6 bg-white">
      <div className="max-w-4xl mx-auto">
        <div className="mb-6">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold mb-2">
              Artifact: {artifact.bucketPath}
              <Badge variant="secondary">{artifact.sourceType}</Badge>
            </h2>
          </div>
        </div>

        <pre className="whitespace-pre-wrap break-words w-[600px] bg-orange-50">
          {rawContent}
        </pre>
      </div>
    </div>
  );
}
