import { db } from "@/db";
import { PageHeader } from "@/app/components/page-header";
import { LayoutProps } from "rwsdk/router";

export async function SourceLayout({ requestInfo, children }: LayoutProps) {
  const source = await db
    .selectFrom("sources")
    .selectAll()
    .where("id", "=", requestInfo?.params?.sourceID)
    .executeTakeFirstOrThrow();
  if (!source) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-2">Source not found</h1>
          <p className="text-muted-foreground">
            The source you're looking for doesn't exist.
          </p>
          <a
            href="../"
            className="text-blue-600 hover:underline mt-4 inline-block"
          >
            Back
          </a>
        </div>
      </div>
    );
  }
  return (
    <div className="min-h-screen bg-white">
      <PageHeader backUrl="/sources" title={"Sources > " + source.name} />
      <div className="flex h-[calc(100vh-80px)]">{children}</div>
    </div>
  );
}
