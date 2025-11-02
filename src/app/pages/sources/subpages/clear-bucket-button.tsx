"use client";

import { Button } from "@/app/components/ui/button";
import { Trash2 } from "lucide-react";
import { clearBucketFiles } from "./clear-bucket-action";

export function ClearBucketButton({
  prefix,
  sourceID,
  fileCount,
}: {
  prefix: string;
  sourceID: number;
  fileCount: number;
}) {
  const handleClear = async () => {
    const confirmed = window.confirm(
      `Delete all ${fileCount} files with prefix "${prefix}"?`
    );

    if (confirmed) {
      await clearBucketFiles(prefix, sourceID);
    }
  };

  return (
    <Button
      onClick={handleClear}
      variant="destructive"
      disabled={fileCount === 0}
      className="gap-2"
    >
      <Trash2 className="h-4 w-4" />
      Clear all files
    </Button>
  );
}
