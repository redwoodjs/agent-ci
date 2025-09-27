"use client";

import { ArrowLeft, Download } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { Badge } from "@/app/components/ui/badge";
import { Stream } from "../../../types";

interface StreamHeaderProps {
  stream: Stream;
}

export function StreamHeader({ stream }: StreamHeaderProps) {
  const getFreshnessColor = (freshness: string) => {
    switch (freshness) {
      case "Live":
        return "bg-green-100 text-green-800";
      case "Fresh":
        return "bg-blue-100 text-blue-800";
      case "Stale":
        return "bg-yellow-100 text-yellow-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  return (
    <div className="border-b bg-white border-gray-200 px-6 py-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <a href="../" className="w-4 h-4">
            <ArrowLeft className="w-4 h-4" />
          </a>

          <div className="flex items-center gap-3">
            <h1 className="text-xl">{stream.name}</h1>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Badge variant="secondary">Coverage {stream.coverage}%</Badge>
            <Badge className={getFreshnessColor(stream.freshness)}>
              {stream.freshness}
            </Badge>
            <Badge variant="outline">{stream.subjects} Subjects</Badge>
            <Badge variant="outline">{stream.agents} Agents</Badge>
          </div>

          <Button variant="outline" size="sm">
            <Download className="w-4 h-4 mr-2" />
            Install MCP
          </Button>
        </div>
      </div>
    </div>
  );
}
