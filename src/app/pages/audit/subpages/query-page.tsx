"use client";

import { useState } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from "@/app/components/ui/card";
import { Button } from "@/app/components/ui/button";
import { queryRag } from "./actions";

export function QueryPage() {
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) {
      setError("Query cannot be empty");
      return;
    }

    setLoading(true);
    setError(null);
    setResponse(null);

    try {
      const result = await queryRag(query);
      if (result.success) {
        setResponse(result.response || "");
      } else {
        setError(result.error || "Failed to process query");
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "An unexpected error occurred"
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-3xl font-bold mb-8">RAG Query</h1>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Query the RAG Engine</CardTitle>
          <CardDescription>
            Enter your query below to search the indexed documents
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <textarea
                placeholder="Enter your query..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                disabled={loading}
                rows={4}
                className="w-full min-h-[100px] rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
              />
            </div>
            <Button type="submit" disabled={loading || !query.trim()}>
              {loading ? "Querying..." : "Query"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {error && (
        <Card className="mb-6 border-red-500">
          <CardHeader>
            <CardTitle className="text-red-600">Error</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-red-600">{error}</p>
          </CardContent>
        </Card>
      )}

      {response && (
        <Card>
          <CardHeader>
            <CardTitle>Response</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="whitespace-pre-wrap text-sm">{response}</div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

