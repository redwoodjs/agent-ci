import { Search } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/app/components/ui/card";

import { db } from "@/db";
import { FetchSourcesButton } from "./fetch-sources-button";

export async function SourceListPage() {
  const sources = await db.selectFrom("sources").selectAll().execute();

  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="mb-2 text-2xl text-black font-bold">Sources</h1>
            <p className="text-muted-foreground">Data sources stored in R2</p>
          </div>
          <div className="flex gap-2">
            <FetchSourcesButton />
            <a href="/sources/new">
              <Button className="bg-green-600 hover:bg-green-700">
                Create source
              </Button>
            </a>
          </div>
        </div>

        <div className="relative mb-8">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Search..." className="pl-10" />
        </div>

        <div className="grid gap-4">
          {sources.map((source) => (
            <a key={source.id} href={`/sources/${source.id}`}>
              <Card className="cursor-pointer hover:bg-gray-50 transition-colors">
                <CardHeader>
                  <CardTitle>{source.name}</CardTitle>
                  <CardDescription>{source.type}</CardDescription>
                </CardHeader>
              </Card>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
