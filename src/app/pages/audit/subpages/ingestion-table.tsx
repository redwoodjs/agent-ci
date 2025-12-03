"use client";

import { useMemo } from "react";

type R2Object = {
  key: string;
  size: number;
  uploaded: Date | string;
  etag: string;
};

type NormalizedR2Object = {
  key: string;
  size: number;
  uploaded: Date;
  etag: string;
};

export function IngestionTable({ objects }: { objects: R2Object[] }) {
  // Normalize objects but preserve the order from the server.
  const normalizedObjects = useMemo<NormalizedR2Object[]>(() => {
    return objects.map((obj) => ({
      ...obj,
      uploaded:
        obj.uploaded instanceof Date ? obj.uploaded : new Date(obj.uploaded),
    }));
  }, [objects]);

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="border-b">
          <tr>
            <th
              className="text-left py-3 px-4 font-medium text-sm text-gray-500 select-none"
            >
              <div className="flex items-center gap-1">
                Key
              </div>
            </th>
            <th
              className="text-left py-3 px-4 font-medium text-sm text-gray-500 select-none"
            >
              <div className="flex items-center gap-1">
                Size
              </div>
            </th>
            <th
              className="text-left py-3 px-4 font-medium text-sm text-gray-500 select-none"
            >
              <div className="flex items-center gap-1">
                Last Modified
              </div>
            </th>
            <th
              className="text-left py-3 px-4 font-medium text-sm text-gray-500 select-none"
            >
              <div className="flex items-center gap-1">
                ETag
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          {normalizedObjects.map((obj) => (
            <tr key={obj.key} className="border-b hover:bg-gray-50">
              <td className="py-3 px-4 text-sm font-mono">
                <a
                  href={`/audit/ingestion/file/${encodeURIComponent(obj.key)}`}
                  className="text-blue-600 hover:text-blue-800 hover:underline break-all"
                >
                  {obj.key}
                </a>
              </td>
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

