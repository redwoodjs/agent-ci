"use client";

import { useState } from "react";
import { FileUpload } from "./file-upload";
import { Button } from "@/app/components/ui/button";

interface FileUploadSectionProps {
  sourceID: number;
}

export function FileUploadSection({ sourceID }: FileUploadSectionProps) {
  const [isVisible, setIsVisible] = useState(false);

  const handleUploadComplete = () => {
    window.location.reload();
  };

  return (
    <div className="border rounded-lg bg-white">
      <div className="p-4 border-b flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Upload Files</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Add files to this source
          </p>
        </div>
        <Button variant="outline" onClick={() => setIsVisible(!isVisible)}>
          {isVisible ? "Hide" : "Show"}
        </Button>
      </div>
      {isVisible && (
        <div className="p-6">
          <FileUpload
            sourceID={sourceID}
            onUploadComplete={handleUploadComplete}
          />
        </div>
      )}
    </div>
  );
}
