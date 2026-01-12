"use client";

import { useState } from "react";
import { Button } from "@/app/components/ui/button";
import { getRootAncestorAction } from "./actions";

export function ViewInGraphButton({
  momentId,
  namespace,
  prefix,
}: {
  momentId: string;
  namespace: string | null;
  prefix: string | null;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getRootAncestorAction(momentId, {
        momentGraphNamespace: namespace,
        momentGraphNamespacePrefix: prefix,
      });

      if (result.success && result.rootId) {
        const params = new URLSearchParams();
        params.set("rootId", result.rootId);
        params.set("highlightMomentId", momentId);
        params.set("view", "chain");
        if (namespace) {
          params.set("namespace", namespace);
        }
        if (prefix) {
          params.set("prefix", prefix);
        }
        window.location.href = `/audit/knowledge-graph?${params.toString()}`;
      } else {
        setError(result.error || "Failed to find root ancestor");
        setLoading(false);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "An unexpected error occurred"
      );
      setLoading(false);
    }
  };

  return (
    <div className="mt-2">
      <Button
        onClick={handleClick}
        disabled={loading}
        className="text-xs px-3 py-1 h-auto bg-blue-600 hover:bg-blue-700 text-white"
        size="sm"
      >
        {loading ? "Loading..." : "View in Graph"}
      </Button>
      {error && <div className="text-xs text-red-600 mt-1">{error}</div>}
    </div>
  );
}
