import { AppDatabase, db } from "@/db";
import {
  SourcesView,
  type SourceProp,
} from "@/app/components/views/sources-view";

export async function SourcesPage({
  params,
}: {
  params: { streamID: string };
}) {
  const stream = await db
    .selectFrom("streams")
    .selectAll()
    .where("id", "=", params.streamID)
    .executeTakeFirstOrThrow();

  let sources: SourceProp[] = [];
  if (Array.isArray(stream.sources)) {
    sources = await db
      .selectFrom("sources")
      .leftJoin("artifacts", "artifacts.source_id", "sources.id")
      .where("sources.id", "in", stream.sources)
      .selectAll("sources")
      .select((eb) => eb.fn.count<number>("artifacts.id").as("artifactCount"))
      .groupBy("sources.id")
      .execute();
  }

  return <SourcesView sources={sources} />;
}
