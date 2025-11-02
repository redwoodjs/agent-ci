"use client";

import { Button } from "@/app/components/ui/button";
import { RefreshCw } from "lucide-react";

export function FetchSourcesButton() {
  const handleFetch = () => {
    window.location.href = "/ingestors/discord/ingest";
  };

  return (
    <Button onClick={handleFetch} className="gap-2" variant="outline">
      <RefreshCw className="h-4 w-4" />
      Fetch sources
    </Button>
  );
}
