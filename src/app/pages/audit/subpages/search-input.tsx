"use client";

import { useState, useEffect } from "react";
import { Input } from "@/app/components/ui/input";
import { Button } from "@/app/components/ui/button";

export function SearchInput({
  source,
  namespace,
  prefix,
  initialQuery,
}: {
  source: "github" | "discord" | "cursor" | "antigravity" | "unknown" | null;
  namespace: string | null;
  prefix: string | null;
  initialQuery: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [isNavigating, setIsNavigating] = useState(false);

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  const handleSearch = () => {
    const params = new URLSearchParams();
    if (source) params.set("source", source);
    if (namespace) params.set("namespace", namespace);
    if (prefix) params.set("prefix", prefix);
    if (query.trim()) params.set("q", query.trim());
    // Reset to page 1 when searching
    const url = `/audit/namespace/moments?${params.toString()}`;
    window.location.href = url;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      handleSearch();
    }
  };

  const handleClear = () => {
    setQuery("");
    const params = new URLSearchParams();
    if (source) params.set("source", source);
    if (namespace) params.set("namespace", namespace);
    if (prefix) params.set("prefix", prefix);
    const url = `/audit/namespace/moments?${params.toString()}`;
    window.location.href = url;
  };

  return (
    <div className="flex gap-2">
      <Input
        type="text"
        placeholder="Search by title, summary, author, or document ID..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        className="flex-1"
      />
      <Button onClick={handleSearch} disabled={isNavigating}>
        {isNavigating ? "Searching..." : "Search"}
      </Button>
      {query && (
        <Button onClick={handleClear} variant="outline">
          Clear
        </Button>
      )}
    </div>
  );
}
