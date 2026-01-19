"use client";

import { useState } from "react";
import { Button } from "@/app/components/ui/button";

export function CopyTextButton({
  text,
  label,
}: {
  text: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doCopy = async () => {
    setError(null);
    setCopied(false);
    try {
      await navigator.clipboard.writeText(text ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="secondary" onClick={doCopy}>
        {copied ? "Copied" : label ?? "Copy"}
      </Button>
      {error ? <div className="text-xs text-red-700">{error}</div> : null}
    </div>
  );
}

