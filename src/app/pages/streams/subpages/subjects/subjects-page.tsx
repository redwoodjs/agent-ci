import { db } from "@/db";
import { Heading } from "@/app/components/ui/Heading";
import { RewriteQuery } from "./rewrite-query";

export async function SubjectsPage({
  params,
}: {
  params: { streamID: string };
}) {
  const streamID = parseInt(params.streamID);
  // grab the subjects from the stream

  // this will be a function that we run that builds up the "subject"
  // user input builds up subjects; which builds up more subjects
  // and matches the document?
  // Or something along those lines.
  const stream = await db
    .selectFrom("streams")
    .selectAll()
    .where("id", "=", streamID)
    .executeTakeFirstOrThrow();

  // here we'll ask autorag to match against our prompt.

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <Heading>Subjects</Heading>
      <p className="text-sm text-muted-foreground">
        Search for key topics extracted from this stream's knowledge base.
      </p>
      <RewriteQuery streamID={streamID} initialQuery={stream.subjects} />
    </div>
  );
}
