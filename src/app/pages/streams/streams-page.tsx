import { Search } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { StreamCard } from "./components/stream-card";

import { db } from "@/db";

export async function StreamsListPage() {
  const streams = await db.selectFrom("streams").selectAll().execute();

  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="mb-2 text-2xl text-black font-bold">Streams</h1>
            <p className="text-muted-foreground">
              Streams are knowledge containers that group related subjects.
            </p>
          </div>
          <Button className="bg-green-600 hover:bg-green-700">
            Create stream
          </Button>
        </div>

        <div className="relative mb-8">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Search..." className="pl-10" />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-8">
          <div>
            <div className="space-y-4">
              {streams.map((stream) => (
                <StreamCard key={stream.id} stream={stream} />
              ))}
            </div>
          </div>

          <div className="space-y-8">
            {/* Placeholder for discovered subjects section */}
          </div>
        </div>
      </div>
    </div>
  );
}
