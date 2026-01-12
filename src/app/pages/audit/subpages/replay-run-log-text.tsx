"use client";

import { useState } from "react";
import { Button } from "@/app/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";

export function ReplayRunLogText({ text }: { text: string }) {
  const [copyError, setCopyError] = useState<string | null>(null);
  const [copiedAt, setCopiedAt] = useState<number | null>(null);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-lg">Text log</CardTitle>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              setCopyError(null);
              try {
                await navigator.clipboard.writeText(text);
                setCopiedAt(Date.now());
              } catch (err) {
                setCopyError(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            Copy
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {copyError && (
          <div className="text-sm text-red-600 mb-2">{copyError}</div>
        )}
        {copiedAt && (
          <div className="text-xs text-gray-600 mb-2">
            Copied at {new Date(copiedAt).toISOString()}
          </div>
        )}
        <textarea
          readOnly
          value={text}
          className="w-full min-h-[520px] font-mono text-xs p-2 border rounded bg-white"
        />
      </CardContent>
    </Card>
  );
}

