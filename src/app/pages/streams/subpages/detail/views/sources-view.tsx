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
import { Stream } from "../../../types";
import { MoreHorizontal, ExternalLink, RefreshCw } from "lucide-react";

interface SourcesViewProps {
  stream: Stream;
}

const mockSources = [
  {
    id: 1,
    type: "Tickets",
    name: "redwoodjs/sdk",
    url: "https://github.com/redwoodjs/sdk",
    description: "redwoodjs/sdk",
    lastSync: "2h ago",
    status: "Active",
    items: 3,
    size: "2.3MB",
  },
  {
    id: 1,
    type: "Pull Requests",
    name: "redwoodjs/sdk",
    url: "https://github.com/redwoodjs/sdk",
    description: "redwoodjs/sdk",
    lastSync: "2h ago",
    status: "Active",
    items: 3,
    size: "2.3MB",
  },
  {
    id: 2,
    type: "Transcripts",
    name: "Technical discussions",
    url: "",
    description: "Discord",
    lastSync: "1d ago",
    status: "Active",
    items: 3,
    size: "2.3MB",
  },
  {
    id: 3,
    type: "Chat",
    name: "RedwoodSDK Discord",
    url: "https://discord.gg/redwoodjs",
    description: "#sdk, #general",
    lastSync: "15m ago",
    status: "Syncing",
    items: 324,
    size: "1.1MB",
  },
  {
    id: 3,
    type: "Machine",
    name: "Devcontainers",
    url: "https://discord.gg/redwoodjs",
    description: "Peter, Justin, & Herman",
    lastSync: "6h ago",
    status: "Active",
    items: 324,
    size: "1.1MB",
  },
];

export function SourcesView({ stream }: SourcesViewProps) {
  const getStatusBadge = (status: string) => {
    switch (status) {
      case "Active":
        return <Badge className="bg-green-100 text-green-800">Active</Badge>;
      case "Syncing":
        return <Badge className="bg-blue-100 text-blue-800">Syncing</Badge>;
      case "Error":
        return <Badge className="bg-red-100 text-red-800">Error</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  return (
    <div className="flex-1 p-6 bg-white">
      <div className="max-w-7xl mx-auto">
        <div className="mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl font-semibold mb-2">Sources</h2>
              <p className="text-muted-foreground">
                Data sources that power this stream's knowledge base.
              </p>
            </div>
            <Button size="sm" className="gap-2">
              <RefreshCw className="w-4 h-4" />
              Sync All
            </Button>
          </div>
        </div>

        <div className="border rounded-lg bg-white">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[300px]">Source</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Items</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead>Last Sync</TableHead>
                <TableHead className="w-[70px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {mockSources.map((source) => (
                <TableRow key={source.id} className="group">
                  <TableCell>
                    <div className="flex flex-col">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{source.name}</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={() => window.open(source.url, "_blank")}
                        >
                          <ExternalLink className="w-3 h-3" />
                        </Button>
                      </div>
                      <span className="text-sm text-muted-foreground">
                        {source.description}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{source.type}</Badge>
                  </TableCell>
                  <TableCell>{getStatusBadge(source.status)}</TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {source.items.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {source.size}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {source.lastSync}
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                      <MoreHorizontal className="w-4 h-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="mt-4 text-sm text-muted-foreground">
          Showing {mockSources.length} of {mockSources.length} sources
        </div>
      </div>
    </div>
  );
}
