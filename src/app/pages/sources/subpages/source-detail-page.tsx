import { db } from "@/db";
import { env } from "cloudflare:workers";
import { ClearBucketButton } from "./clear-bucket-button";
import { FileUploadSection } from "./file-upload-section";
import { FileListWithSelection } from "./file-list-with-selection";

interface R2FileInfo {
  key: string;
  size: number;
  uploaded: Date;
}

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
    ? `${bucketPrefix}${currentPath}${currentPath.endsWith("/") ? "" : "/"}`
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
    const parts = relativePath.split("/");

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
          ? `${currentPath}${currentPath.endsWith("/") ? "" : "/"}${parts[0]}`
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

  for (const item of items) {
    if (item.type === "folder") {
      const folderPrefix = `${fullPrefix}${item.name}/`;
      const folderFiles = allFiles.filter((f) =>
        f.key.startsWith(folderPrefix)
      );
      if (folderFiles.length > 0) {
        item.key = folderFiles[0].key.slice(0, folderPrefix.length);
      }
    }
  }

  const breadcrumbs: Array<{ name: string; path: string }> = [
    { name: source.name, path: `/sources/${sourceID}` },
  ];

  if (currentPath) {
    const pathParts = currentPath.split("/").filter(Boolean);
    let accumulatedPath = "";

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

        <FileListWithSelection items={items} sourceID={sourceID} />
      </div>
    </div>
  );
}
