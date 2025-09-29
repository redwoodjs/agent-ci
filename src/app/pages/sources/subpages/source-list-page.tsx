import { Search } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";

import { db } from "@/db";
import { SourcesView } from "@/app/components/views/sources-view";

export async function SourceListPage() {
  const sources = await db
    .selectFrom("sources")
    .leftJoin("artifacts", "artifacts.sourceID", "sources.id")

    .selectAll("sources")
    .select((eb) => eb.fn.count<number>("artifacts.id").as("artifactCount"))
    .groupBy("sources.id")
    .execute();

  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="mb-2 text-2xl text-black font-bold">Sources</h1>
            <p className="text-muted-foreground">
              Sources produce artifacts that are parsed into subjects
            </p>
          </div>
          <Button className="bg-green-600 hover:bg-green-700">
            Create source
          </Button>
        </div>

        <div className="relative mb-8">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Search..." className="pl-10" />
        </div>

        <SourcesView sources={sources} />
      </div>
    </div>
  );
}
