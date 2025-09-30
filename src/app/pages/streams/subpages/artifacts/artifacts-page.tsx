import { Card } from "@/app/components/ui/card";
import { Badge } from "@/app/components/ui/badge";
import { FindArtifactsButton } from "./find-artifacts-button";

import { Clock } from "lucide-react";
import { db } from "@/db";

export async function ArtifactsPage({
  params,
}: {
  params: { streamID: string };
}) {
  const streamID = parseInt(params.streamID);

  const artifacts = await db
    .selectFrom("stream_artifacts")
    .where("streamID", "=", streamID)
    .innerJoin("artifacts", "artifacts.id", "stream_artifacts.artifactID")
    .innerJoin("sources", "sources.id", "artifacts.sourceID")
    .selectAll("artifacts")
    .select(["sources.type as sourceType", "stream_artifacts.score"])
    .execute();

  return (
    <div className="flex-1 p-6 bg-white">
      <div className="max-w-4xl mx-auto">
        <div className="mb-6">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold mb-2">Artifacts</h2>
            <FindArtifactsButton streamID={streamID} />
          </div>
          <p className="text-muted-foreground">Recent activity and updates</p>
        </div>

        {artifacts.length === 0 && (
          <div className="text-muted-foreground">No artifacts found</div>
        )}

        <div className="space-y-4">
          {artifacts.map((artifact) => (
            <Card
              key={artifact.id}
              className="p-6 bg-white border border-gray-200"
            >
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center`}
                  >
                    <Clock className="w-4 h-4" />
                  </div>
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="font-medium">
                      <a href={`/streams/${streamID}/artifacts/${artifact.id}`}>
                        {artifact.bucketPath}
                      </a>
                    </h3>
                    <Badge variant="secondary">{artifact.sourceType}</Badge>
                    {Math.floor(artifact.score * 100)}%
                  </div>
                  <p className="text-sm text-muted-foreground mb-2">
                    {/* {artifact.summary} */}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {artifact.createdAt}
                  </p>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
