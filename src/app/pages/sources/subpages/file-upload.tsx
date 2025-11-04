"use client";

import { useState, useRef } from "react";
import { Button } from "@/app/components/ui/button";
import { uploadFile } from "./upload-files-action";

interface FileUploadProps {
  sourceID: number;
  onUploadComplete?: () => void;
}

export function FileUpload({ sourceID, onUploadComplete }: FileUploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    await uploadFiles(files);
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const files = Array.from(e.target.files);
      await uploadFiles(files);
    }
  };

  const uploadFiles = async (files: File[]) => {
    if (files.length === 0) return;

    setUploading(true);
    setUploadProgress([]);

    for (const file of files) {
      setUploadProgress((prev) => [...prev, `Uploading ${file.name}...`]);

      const formData = new FormData();
      formData.append("file", file);
      formData.append("sourceID", sourceID.toString());

      try {
        const result = await uploadFile(formData);

        if (result.success) {
          setUploadProgress((prev) => [
            ...prev.slice(0, -1),
            `✓ ${file.name} uploaded`,
          ]);
        } else {
          setUploadProgress((prev) => [
            ...prev.slice(0, -1),
            `✗ ${file.name} failed: ${result.error}`,
          ]);
        }
      } catch (error) {
        setUploadProgress((prev) => [
          ...prev.slice(0, -1),
          `✗ ${file.name} failed`,
        ]);
      }
    }

    setUploading(false);

    setTimeout(() => {
      setUploadProgress([]);
      if (onUploadComplete) {
        onUploadComplete();
      }
    }, 2000);
  };

  return (
    <div className="space-y-4">
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
          isDragging
            ? "border-blue-500 bg-blue-50"
            : "border-gray-300 bg-gray-50"
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileSelect}
          className="hidden"
        />

        <div className="space-y-4">
          <div className="text-4xl">📁</div>
          <div>
            <p className="text-lg font-medium text-gray-700">
              Drag and drop files here
            </p>
            <p className="text-sm text-gray-500 mt-1">or click to browse</p>
          </div>
          <Button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="bg-blue-600 hover:bg-blue-700"
          >
            {uploading ? "Uploading..." : "Select Files"}
          </Button>
        </div>
      </div>

      {uploadProgress.length > 0 && (
        <div className="bg-gray-50 border rounded-lg p-4 space-y-2">
          {uploadProgress.map((msg, idx) => (
            <div key={idx} className="text-sm font-mono text-gray-700">
              {msg}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
