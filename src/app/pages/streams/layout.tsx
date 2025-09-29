import { db } from "@/db";
import { PageHeader } from "@/app/components/page-header";
import { LeftRail } from "./components/left-rail";
import { LayoutProps } from "rwsdk/router";

export async function StreamLayout({ requestInfo, children }: LayoutProps) {
  const stream = await db
    .selectFrom("streams")
    .selectAll()
    .where("id", "=", requestInfo?.params?.streamID)
    .executeTakeFirstOrThrow();

  if (!stream) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-2">Stream not found</h1>
          <p className="text-muted-foreground">
            The stream you're looking for doesn't exist.
          </p>
          <a
            href="/streams"
            className="text-blue-600 hover:underline mt-4 inline-block"
          >
            Back to streams
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white">
      <PageHeader title={stream.name} />

      <div className="flex h-[calc(100vh-80px)]">
        <LeftRail />

        {children}
      </div>
    </div>
  );
}
