"use client";

import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table";
import { Button } from "@/app/components/ui/button";
import { Trash2 } from "lucide-react";
import { deleteSelectedFiles } from "./delete-files-action";

interface FolderItem {
  name: string;
  type: "folder";
  path: string;
  key?: string;
}

interface FileItem {
  name: string;
  type: "file";
  key: string;
  size: number;
  uploaded: Date;
}

type DirectoryItem = FolderItem | FileItem;

interface FileListWithSelectionProps {
  items: DirectoryItem[];
  sourceID: number;
  onDelete?: () => void;
}

export function FileListWithSelection({
  items,
  sourceID,
  onDelete,
}: FileListWithSelectionProps) {
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [isDeleting, setIsDeleting] = useState(false);

  const getItemKey = (item: DirectoryItem): string => {
    if (item.type === "file") {
      return item.key;
    } else {
      return item.key || item.path;
    }
  };

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      const allKeys = new Set(items.map(getItemKey));
      setSelectedKeys(allKeys);
    } else {
      setSelectedKeys(new Set());
    }
  };

  const handleSelectItem = (itemKey: string, checked: boolean) => {
    const newSelected = new Set(selectedKeys);
    if (checked) {
      newSelected.add(itemKey);
    } else {
      newSelected.delete(itemKey);
    }
    setSelectedKeys(newSelected);
  };

  const handleDelete = async () => {
    const count = selectedKeys.size;
    const confirmed = window.confirm(
      `Delete ${count} selected ${count === 1 ? "item" : "items"}? This will delete files and all contents of folders.`
    );

    if (confirmed) {
      setIsDeleting(true);
      try {
        await deleteSelectedFiles(Array.from(selectedKeys));
        setSelectedKeys(new Set());
        if (onDelete) {
          onDelete();
        }
        window.location.reload();
      } catch (error) {
        console.error("Error deleting files:", error);
        alert("Failed to delete files");
      } finally {
        setIsDeleting(false);
      }
    }
  };

  const allSelected = items.length > 0 && selectedKeys.size === items.length;
  const someSelected = selectedKeys.size > 0 && !allSelected;

  return (
    <div className="border rounded-lg bg-white">
      <div className="p-4 border-b flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">
            {items.length > 0 ? "Files and Folders" : "R2 Storage Files"}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            {items.length} {items.length === 1 ? "item" : "items"}
            {selectedKeys.size > 0 &&
              ` • ${selectedKeys.size} selected`}
          </p>
        </div>
        {selectedKeys.size > 0 && (
          <Button
            onClick={handleDelete}
            variant="destructive"
            disabled={isDeleting}
            className="gap-2"
          >
            <Trash2 className="h-4 w-4" />
            {isDeleting ? "Deleting..." : `Delete ${selectedKeys.size}`}
          </Button>
        )}
      </div>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-12">
              <input
                type="checkbox"
                checked={allSelected}
                ref={(input) => {
                  if (input) {
                    input.indeterminate = someSelected;
                  }
                }}
                onChange={(e) => handleSelectAll(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 cursor-pointer"
              />
            </TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Size</TableHead>
            <TableHead>Uploaded</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={4}
                className="text-center text-muted-foreground"
              >
                No items found
              </TableCell>
            </TableRow>
          ) : (
            items.map((item, index) => {
              const itemKey = getItemKey(item);
              const isSelected = selectedKeys.has(itemKey);

              return (
                <TableRow key={index} className="group">
                  <TableCell>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={(e) =>
                        handleSelectItem(itemKey, e.target.checked)
                      }
                      className="w-4 h-4 rounded border-gray-300 cursor-pointer"
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {item.type === "folder" ? (
                        <>
                          <svg
                            className="w-4 h-4 text-blue-500"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                            />
                          </svg>
                          <a
                            href={`/sources/${sourceID}/browse/${item.path}`}
                            className="font-medium text-blue-600 hover:text-blue-800 hover:underline"
                          >
                            {item.name}
                          </a>
                        </>
                      ) : (
                        <>
                          <svg
                            className="w-4 h-4 text-gray-400"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                            />
                          </svg>
                          <a
                            href={`/sources/${sourceID}/files/${item.key}`}
                            className="font-mono text-sm text-blue-600 hover:text-blue-800 hover:underline"
                          >
                            {item.name}
                          </a>
                        </>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {item.type === "file" ? formatBytes(item.size) : "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {item.type === "file"
                      ? new Date(item.uploaded).toLocaleString()
                      : "—"}
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

