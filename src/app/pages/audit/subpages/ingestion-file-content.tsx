"use client";

import { useState } from "react";
import { Button } from "@/app/components/ui/button";
import { DiscordConversation } from "./discord-conversation";
import type { components } from "@/app/ingestors/discord/discord-api-types";

type DiscordMessage = components["schemas"]["MessageResponse"];

interface IngestionFileContentProps {
  rawContent: string;
  messages: DiscordMessage[] | null;
  isDiscord: boolean;
  truncated: boolean;
}

export function IngestionFileContent({
  rawContent,
  messages,
  isDiscord,
  truncated,
}: IngestionFileContentProps) {
  const [viewMode, setViewMode] = useState<"formatted" | "raw">(
    isDiscord && messages ? "formatted" : "raw"
  );

  return (
    <div className="space-y-4">
      {isDiscord && messages && (
        <div className="flex gap-2">
          <Button
            variant={viewMode === "formatted" ? "default" : "outline"}
            size="sm"
            onClick={() => setViewMode("formatted")}
          >
            Formatted
          </Button>
          <Button
            variant={viewMode === "raw" ? "default" : "outline"}
            size="sm"
            onClick={() => setViewMode("raw")}
          >
            Raw
          </Button>
        </div>
      )}

      {viewMode === "formatted" && messages ? (
        <DiscordConversation messages={messages} />
      ) : (
        <div className="border rounded-md bg-black text-gray-100 text-sm overflow-auto max-h-[70vh]">
          <pre className="p-4 whitespace-pre-wrap break-words font-mono text-xs">
            {rawContent}
            {truncated && "\n\n---\n(truncated) ---"}
          </pre>
        </div>
      )}
    </div>
  );
}
