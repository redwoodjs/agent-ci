"use client";

import { useState, useMemo } from "react";
import { Button } from "@/app/components/ui/button";
import { enqueueFile, enqueueFiles, deleteFile, deleteFiles } from "./actions";
import { useTableSort } from "./use-table-sort";

type File = {
  key: string;
  size: number;
  uploaded: Date | string;
  etag: string;
  indexed: boolean;
  indexedAt?: string;
  indexedEtag?: string;
  chunkCount: number;
  needsReindex: boolean;
  isValid: boolean;
};

type SortableFile = {
  key: string;
  size: number;
  uploaded: Date;
  etag: string;
  indexed: boolean;
  indexedAt: Date | null;
  indexedEtag?: string;
  chunkCount: number;
  needsReindex: boolean;
  isValid: boolean;
};

export function IndexingTable({ files }: { files: File[] }) {
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  // Normalize files for sorting (convert uploaded and indexedAt to Date objects)
  const normalizedFiles = useMemo<SortableFile[]>(() => {
    return files.map((file) => ({
      ...file,
      uploaded:
        typeof file.uploaded === "string"
          ? new Date(file.uploaded)
          : file.uploaded,
      indexedAt: file.indexedAt ? new Date(file.indexedAt) : null,
    }));
  }, [files]);

  const { sortedData, sortConfig, handleSort } = useTableSort<SortableFile>(
    normalizedFiles,
    { key: "uploaded", direction: "desc" } // Default: newest first by Last Modified
  );

  const toggleSelection = (key: string) => {
    const newSelected = new Set(selectedKeys);
    if (newSelected.has(key)) {
      newSelected.delete(key);
    } else {
      newSelected.add(key);
    }
    setSelectedKeys(newSelected);
  };

  const toggleSelectAll = () => {
    if (selectedKeys.size === sortedData.length) {
      setSelectedKeys(new Set());
    } else {
      setSelectedKeys(new Set(sortedData.map((f) => f.key)));
    }
  };

  const handleEnqueue = async (r2Key: string) => {
    setLoadingKeys((prev) => new Set(prev).add(r2Key));
    setMessage(null);

    try {
      const result = await enqueueFile(r2Key);
      if (result.success) {
        setMessage({ type: "success", text: result.message || "" });
      } else {
        setMessage({
          type: "error",
          text: result.error || "Failed to enqueue file",
        });
      }
    } catch (error) {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to enqueue file",
      });
    } finally {
      setLoadingKeys((prev) => {
        const next = new Set(prev);
        next.delete(r2Key);
        return next;
      });
    }
  };

  const handleDelete = async (r2Key: string) => {
    if (!confirm(`Are you sure you want to delete ${r2Key}?`)) {
      return;
    }

    setLoadingKeys((prev) => new Set(prev).add(r2Key));
    setMessage(null);

    try {
      const result = await deleteFile(r2Key);
      if (result.success) {
        setMessage({ type: "success", text: result.message || "" });
        // Reload the page to refresh the list
        setTimeout(() => window.location.reload(), 1000);
      } else {
        setMessage({
          type: "error",
          text: result.error || "Failed to delete file",
        });
      }
    } catch (error) {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to delete file",
      });
    } finally {
      setLoadingKeys((prev) => {
        const next = new Set(prev);
        next.delete(r2Key);
        return next;
      });
    }
  };

  const handleBulkEnqueue = async () => {
    if (selectedKeys.size === 0) {
      setMessage({ type: "error", text: "Please select at least one file" });
      return;
    }

    setBulkLoading(true);
    setMessage(null);

    try {
      const keys = Array.from(selectedKeys);
      const result = await enqueueFiles(keys);
      if (result.success) {
        setMessage({ type: "success", text: result.message || "" });
        setSelectedKeys(new Set());
      } else {
        setMessage({
          type: "error",
          text: result.error || "Failed to enqueue files",
        });
      }
    } catch (error) {
      setMessage({
        type: "error",
        text:
          error instanceof Error ? error.message : "Failed to enqueue files",
      });
    } finally {
      setBulkLoading(false);
    }
  };

  const handleBulkDelete = async () => {
    const selectedFilesArray = files.filter((f) => selectedKeys.has(f.key));
    const invalidCount = selectedFilesArray.filter((f) => !f.isValid).length;

    if (
      !confirm(
        `Are you sure you want to delete ${selectedKeys.size} selected files${
          invalidCount > 0 ? ` (${invalidCount} invalid)` : ""
        }?`
      )
    ) {
      return;
    }

    setBulkLoading(true);
    setMessage(null);

    try {
      const keys = Array.from(selectedKeys);
      const result = await deleteFiles(keys);
      if (result.success) {
        setMessage({ type: "success", text: result.message || "" });
        setSelectedKeys(new Set());
        // Reload the page to refresh the list
        setTimeout(() => window.location.reload(), 1000);
      } else {
        setMessage({
          type: "error",
          text: result.error || "Failed to delete files",
        });
      }
    } catch (error) {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to delete files",
      });
    } finally {
      setBulkLoading(false);
    }
  };

  return (
    <div>
      {message && (
        <div
          className={`mb-4 p-3 rounded ${
            message.type === "success"
              ? "bg-green-100 text-green-800"
              : "bg-red-100 text-red-800"
          }`}
        >
          {message.text}
        </div>
      )}

      {selectedKeys.size > 0 && (
        <div className="mb-4 flex items-center gap-4">
          <Button
            onClick={handleBulkEnqueue}
            disabled={bulkLoading}
            variant="default"
          >
            {bulkLoading
              ? `Enqueuing ${selectedKeys.size} files...`
              : `Bulk Index ${selectedKeys.size} Selected`}
          </Button>
          <Button
            onClick={handleBulkDelete}
            disabled={bulkLoading}
            variant="destructive"
          >
            {bulkLoading
              ? `Deleting ${selectedKeys.size} files...`
              : `Delete ${selectedKeys.size} Selected`}
          </Button>
          <Button
            onClick={() => setSelectedKeys(new Set())}
            variant="outline"
            disabled={bulkLoading}
          >
            Clear Selection
          </Button>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="border-b">
            <tr>
              <th className="text-left py-3 px-4 font-medium text-sm text-gray-500">
                <input
                  type="checkbox"
                  checked={
                    selectedKeys.size === sortedData.length && sortedData.length > 0
                  }
                  onChange={toggleSelectAll}
                  className="cursor-pointer"
                />
              </th>
              <th
                className="text-left py-3 px-4 font-medium text-sm text-gray-500 cursor-pointer hover:bg-gray-100 select-none"
                onClick={() => handleSort("key")}
              >
                <div className="flex items-center gap-1">
                  Key
                  {sortConfig.key === "key" && (
                    <span className="text-xs">
                      {sortConfig.direction === "asc" ? "↑" : "↓"}
                    </span>
                  )}
                </div>
              </th>
              <th
                className="text-left py-3 px-4 font-medium text-sm text-gray-500 cursor-pointer hover:bg-gray-100 select-none"
                onClick={() => handleSort("indexed")}
              >
                <div className="flex items-center gap-1">
                  Status
                  {sortConfig.key === "indexed" && (
                    <span className="text-xs">
                      {sortConfig.direction === "asc" ? "↑" : "↓"}
                    </span>
                  )}
                </div>
              </th>
              <th
                className="text-left py-3 px-4 font-medium text-sm text-gray-500 cursor-pointer hover:bg-gray-100 select-none"
                onClick={() => handleSort("chunkCount")}
              >
                <div className="flex items-center gap-1">
                  Chunks
                  {sortConfig.key === "chunkCount" && (
                    <span className="text-xs">
                      {sortConfig.direction === "asc" ? "↑" : "↓"}
                    </span>
                  )}
                </div>
              </th>
              <th
                className="text-left py-3 px-4 font-medium text-sm text-gray-500 cursor-pointer hover:bg-gray-100 select-none"
                onClick={() => handleSort("indexedAt")}
              >
                <div className="flex items-center gap-1">
                  Indexed At
                  {sortConfig.key === "indexedAt" && (
                    <span className="text-xs">
                      {sortConfig.direction === "asc" ? "↑" : "↓"}
                    </span>
                  )}
                </div>
              </th>
              <th
                className="text-left py-3 px-4 font-medium text-sm text-gray-500 cursor-pointer hover:bg-gray-100 select-none"
                onClick={() => handleSort("uploaded")}
              >
                <div className="flex items-center gap-1">
                  Last Modified
                  {sortConfig.key === "uploaded" && (
                    <span className="text-xs">
                      {sortConfig.direction === "asc" ? "↑" : "↓"}
                    </span>
                  )}
                </div>
              </th>
              <th className="text-left py-3 px-4 font-medium text-sm text-gray-500">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedData.map((file) => (
              <tr key={file.key} className="border-b hover:bg-gray-50">
                <td className="py-3 px-4">
                  <input
                    type="checkbox"
                    checked={selectedKeys.has(file.key)}
                    onChange={() => toggleSelection(file.key)}
                    className="cursor-pointer"
                  />
                </td>
                <td className="py-3 px-4 text-sm font-mono max-w-md truncate">
                  {file.key}
                </td>
                <td className="py-3 px-4 text-sm">
                  {!file.isValid ? (
                    <span className="px-2 py-1 bg-gray-100 text-gray-800 rounded text-xs">
                      Invalid
                    </span>
                  ) : file.needsReindex ? (
                    <span className="px-2 py-1 bg-red-100 text-red-800 rounded text-xs">
                      Needs Reindex
                    </span>
                  ) : file.indexed ? (
                    <span className="px-2 py-1 bg-green-100 text-green-800 rounded text-xs">
                      Indexed
                    </span>
                  ) : (
                    <span className="px-2 py-1 bg-orange-100 text-orange-800 rounded text-xs">
                      Pending
                    </span>
                  )}
                </td>
                <td className="py-3 px-4 text-sm">{file.chunkCount}</td>
                <td className="py-3 px-4 text-sm text-gray-500">
                  {file.indexedAt ? file.indexedAt.toLocaleString() : "-"}
                </td>
                <td className="py-3 px-4 text-sm text-gray-500">
                  {file.uploaded.toLocaleString()}
                </td>
                <td className="py-3 px-4">
                  <div className="flex gap-2">
                    {file.isValid ? (
                      <Button
                        onClick={() => handleEnqueue(file.key)}
                        disabled={loadingKeys.has(file.key)}
                        size="sm"
                        variant="outline"
                      >
                        {loadingKeys.has(file.key) ? "Enqueuing..." : "Enqueue"}
                      </Button>
                    ) : (
                      <Button
                        onClick={() => handleDelete(file.key)}
                        disabled={loadingKeys.has(file.key)}
                        size="sm"
                        variant="destructive"
                      >
                        {loadingKeys.has(file.key) ? "Deleting..." : "Delete"}
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
