import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table";
import { ExternalLink, RefreshCw } from "lucide-react";
import { AppDatabase } from "@/db";

function formatRelativeTime(isoString: string) {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();

  const minutes = Math.floor(diffMs / (1000 * 60));
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

export type SourceProp = AppDatabase["sources"] & { artifactCount: number };

export async function SourcesView({ sources }: { sources: SourceProp[] }) {
  return (
    <div className="flex-1 p-6 bg-white">
      <div className="max-w-7xl mx-auto">
        <div className="border rounded-lg bg-white">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[300px]">Source</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Bucket</TableHead>
                <TableHead>Artifacts</TableHead>
                <TableHead>Last Update</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sources.map((source) => (
                <TableRow key={source.id} className="group">
                  <TableCell>
                    <div className="flex flex-col">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{source.name}</span>
                        {source.url && (
                          <a
                            href={source.url}
                            target="_blank"
                            className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                      <span className="text-sm text-muted-foreground">
                        {/* {source.description} */}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{source.type}</Badge>
                  </TableCell>

                  <TableCell className="text-sm text-muted-foreground">
                    {source.bucket}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <a href={`/sources/${source.id}`}>{source.artifactCount}</a>
                  </TableCell>
                  <TableCell>{source.updatedAt}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="mt-4 text-sm text-muted-foreground">
          Showing {sources.length} of {sources.length} sources
        </div>
      </div>
    </div>
  );
}
