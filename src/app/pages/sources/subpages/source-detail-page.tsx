import { db } from "@/db";
import { env } from "cloudflare:workers";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table";
import { ClearBucketButton } from "./clear-bucket-button";
import { FileUploadSection } from "./file-upload-section";

interface R2FileInfo {
  key: string;
  size: number;
  uploaded: Date;
}

interface FolderItem {
  name: string;
  type: "folder";
  path: string;
}

interface FileItem {
  name: string;
  type: "file";
  key: string;
  size: number;
  uploaded: Date;
}

type DirectoryItem = FolderItem | FileItem;

export async function SourceDetailPage({
  params,
}: {
  params: { sourceID: string; $0?: string };
}) {
  const sourceID = parseInt(params.sourceID);
  const currentPath = params.$0 || "";

  const source = await db
    .selectFrom("sources")
    .selectAll()
    .where("id", "=", sourceID)
    .executeTakeFirst();

  if (!source) {
    return <div>Source not found</div>;
  }

  let bucketPrefix = "";
  let guildID = "";
  let channelID = "";

  if (source.type === "discord") {
    try {
      const description = JSON.parse(source.description);
      guildID = description.guildID || "";
      channelID = description.channelID || "";
      if (guildID && channelID) {
        bucketPrefix = `discord/${guildID}/${channelID}/`;
      } else {
        bucketPrefix = "discord/";
      }
    } catch {
      bucketPrefix = "discord/";
    }
  } else {
    bucketPrefix = source.bucket || "";
  }

  const fullPrefix = currentPath 
    ? `${bucketPrefix}${currentPath}${currentPath.endsWith('/') ? '' : '/'}`
    : bucketPrefix;

  const allFiles: R2FileInfo[] = [];
  let cursor: string | undefined = undefined;

  do {
    const listed = await env.MACHINEN_BUCKET.list({
      prefix: fullPrefix,
      cursor,
    });

    for (const object of listed.objects) {
      allFiles.push({
        key: object.key,
        size: object.size,
        uploaded: object.uploaded,
      });
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  const items: DirectoryItem[] = [];
  const seenFolders = new Set<string>();

  for (const file of allFiles) {
    const relativePath = file.key.slice(fullPrefix.length);
    const parts = relativePath.split('/');

    if (parts.length === 1) {
      items.push({
        name: parts[0],
        type: "file",
        key: file.key,
        size: file.size,
        uploaded: file.uploaded,
      });
    } else if (parts.length > 1 && parts[0]) {
      if (!seenFolders.has(parts[0])) {
        seenFolders.add(parts[0]);
        const folderPath = currentPath 
          ? `${currentPath}${currentPath.endsWith('/') ? '' : '/'}${parts[0]}`
          : parts[0];
        items.push({
          name: parts[0],
          type: "folder",
          path: folderPath,
        });
      }
    }
  }

  items.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "folder" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  const breadcrumbs: Array<{ name: string; path: string }> = [
    { name: source.name, path: `/sources/${sourceID}` },
  ];
  
  if (currentPath) {
    const pathParts = currentPath.split('/').filter(Boolean);
    let accumulatedPath = '';
    
    for (const part of pathParts) {
      accumulatedPath = accumulatedPath ? `${accumulatedPath}/${part}` : part;
      breadcrumbs.push({
        name: part,
        path: `/sources/${sourceID}/browse/${accumulatedPath}`,
      });
    }
  }

  return (
    <div className="flex-1 p-6 bg-white w-full">
      <div className="max-w-7xl mx-auto w-full">
        <div className="mb-6 flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
              {breadcrumbs.map((crumb, index) => (
                <div key={index} className="flex items-center gap-2">
                  {index > 0 && <span>/</span>}
                  {index === breadcrumbs.length - 1 ? (
                    <span className="font-medium text-black">{crumb.name}</span>
                  ) : (
                    <a
                      href={crumb.path}
                      className="hover:text-blue-600 hover:underline"
                    >
                      {crumb.name}
                    </a>
                  )}
                </div>
              ))}
            </div>
            <p className="text-muted-foreground">{source.type}</p>
            {source.type === "discord" && guildID && channelID && (
              <p className="text-muted-foreground font-mono text-sm mt-1">
                Guild: {guildID} • Channel: {channelID}
              </p>
            )}
          </div>
          <ClearBucketButton
            prefix={bucketPrefix}
            sourceID={sourceID}
            fileCount={allFiles.length}
          />
        </div>

        <FileUploadSection sourceID={sourceID} />

        <div className="border rounded-lg bg-white">
          <div className="p-4 border-b">
            <h2 className="text-lg font-semibold">
              {currentPath ? "Current Directory" : "R2 Storage Files"}
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              {items.length} {items.length === 1 ? "item" : "items"}
            </p>
          </div>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Uploaded</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={3}
                    className="text-center text-muted-foreground"
                  >
                    No items found
                  </TableCell>
                </TableRow>
              ) : (
                items.map((item, index) => (
                  <TableRow key={index} className="group">
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
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
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
