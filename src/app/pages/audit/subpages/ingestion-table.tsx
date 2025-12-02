"use client";

import { useMemo } from "react";
import { useTableSort } from "./use-table-sort";

type R2Object = {
  key: string;
  size: number;
  uploaded: Date;
  etag: string;
};

type SortableR2Object = {
  key: string;
  size: number;
  uploaded: Date;
  etag: string;
};

export function IngestionTable({ objects }: { objects: R2Object[] }) {
  // Normalize objects for sorting (ensure uploaded is a Date object)
  const normalizedObjects = useMemo<SortableR2Object[]>(() => {
    return objects.map((obj) => ({
      ...obj,
      uploaded:
        obj.uploaded instanceof Date ? obj.uploaded : new Date(obj.uploaded),
    }));
  }, [objects]);

  const { sortedData, sortConfig, handleSort } = useTableSort<SortableR2Object>(
    normalizedObjects,
    { key: "uploaded", direction: "desc" } // Default: newest first
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="border-b">
          <tr>
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
              onClick={() => handleSort("size")}
            >
              <div className="flex items-center gap-1">
                Size
                {sortConfig.key === "size" && (
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
            <th
              className="text-left py-3 px-4 font-medium text-sm text-gray-500 cursor-pointer hover:bg-gray-100 select-none"
              onClick={() => handleSort("etag")}
            >
              <div className="flex items-center gap-1">
                ETag
                {sortConfig.key === "etag" && (
                  <span className="text-xs">
                    {sortConfig.direction === "asc" ? "↑" : "↓"}
                  </span>
                )}
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          {sortedData.map((obj) => (
            <tr key={obj.key} className="border-b hover:bg-gray-50">
              <td className="py-3 px-4 text-sm font-mono">{obj.key}</td>
              <td className="py-3 px-4 text-sm">{formatBytes(obj.size)}</td>
              <td className="py-3 px-4 text-sm">
                {obj.uploaded.toLocaleString()}
              </td>
              <td className="py-3 px-4 font-mono text-xs text-gray-500">
                {obj.etag.substring(0, 16)}...
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}

