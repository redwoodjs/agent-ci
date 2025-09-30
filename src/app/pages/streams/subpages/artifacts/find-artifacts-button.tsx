"use client";

import { useState, useTransition } from "react";
import { Button } from "@/app/components/ui/button";
import { RefreshCcw } from "lucide-react";
import { discoverNewArtifacts } from "./actions";

export function FindArtifactsButton({ streamID }: { streamID: number }) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-2">
      <Button
        onClick={() => {
          startTransition(async () => {
            await discoverNewArtifacts({ streamID });
            // setResult(null);
            // const res = await discoverNewArtifacts({ streamID });
            // try {
            //   const data = await res.json();
            //   if (res.ok) {
            //     setResult(
            //       `Inserted ${data.inserted} artifact${
            //         data.inserted === 1 ? "" : "s"
            //       }`
            //     );
            //   } else {
            //     setResult(data.error ?? "Failed");
            //   }
            // } catch (e) {
            //   setResult("Failed");
            // }
          });
        }}
        variant="outline"
        disabled={isPending}
      >
        <RefreshCcw className="w-4 h-4" />
        {isPending ? "Updating…" : "Find new artifacts"}
      </Button>
      {result ? (
        <span className="text-xs text-muted-foreground">{result}</span>
      ) : null}
    </div>
  );
}
