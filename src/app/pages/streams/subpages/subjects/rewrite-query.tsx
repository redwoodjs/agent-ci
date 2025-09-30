"use client";

import { useState } from "react";
import { rewriteQueryWithMemory, saveQuery } from "./actions";

import { Button } from "@/app/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/app/components/ui/card";

export function RewriteQuery({
  streamID,
  initialQuery,
}: {
  streamID: number;
  initialQuery: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [newQuery, setNewQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  if (newQuery) {
    return (
      <Card className="max-w-2xl">
        <CardHeader className="border-b">
          <CardTitle>Proposed query</CardTitle>
          <CardDescription>
            Review and apply the improved query.
          </CardDescription>
        </CardHeader>
        <CardContent className="py-6">
          <div className="whitespace-pre-wrap text-sm">{newQuery}</div>
        </CardContent>
        <CardFooter className="gap-2 border-t pt-6">
          <Button variant="destructive" onClick={() => setNewQuery("")}>
            Deny
          </Button>
          <Button
            onClick={async () => {
              setQuery(newQuery);
              await saveQuery({ streamID, query: newQuery });
              setNewQuery("");
            }}
          >
            Accept
          </Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card className="max-w-2xl">
      <CardHeader className="border-b">
        <CardTitle>Improve search query</CardTitle>
        <CardDescription>
          Rewrite the query to better match subjects in this stream.
        </CardDescription>
      </CardHeader>
      <CardContent className="py-6">
        <label className="mb-2 block text-sm font-medium">Query</label>
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input w-full min-h-32 rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive"
          placeholder="Describe the key topics to search for"
        />
      </CardContent>
      <CardFooter className="border-t pt-6">
        <Button
          onClick={async () => {
            console.log("rewriting query", query);
            setIsLoading(true);
            const rewrittenQuery = await rewriteQueryWithMemory(query);
            setNewQuery(rewrittenQuery);
            setIsLoading(false);
          }}
          disabled={!query || isLoading}
        >
          {isLoading ? "Rewriting…" : "Improve query"}
        </Button>
      </CardFooter>
    </Card>
  );
}
