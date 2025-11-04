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

export async function SourceDetailPage({
  params,
}: {
  params: { sourceID: string };
}) {
  const sourceID = parseInt(params.sourceID);

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

  const allFiles: R2FileInfo[] = [];
  let cursor: string | undefined = undefined;

  do {
    const listed = await env.MACHINEN_BUCKET.list({
      prefix: bucketPrefix,
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

  return (
    <div className="flex-1 p-6 bg-white w-full">
      <div className="max-w-7xl mx-auto w-full">
        <div className="mb-6 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-black mb-2">
              {source.name}
            </h1>
            <p className="text-muted-foreground">{source.type}</p>
            {source.type === "discord" && guildID && channelID && (
              <p className="text-muted-foreground font-mono text-sm mt-1">
                Guild: {guildID} • Channel: {channelID}
              </p>
            )}
            {source.type !== "discord" && (
              <>
                <p className="text-muted-foreground">{allFiles.length} files</p>
                <p className="text-muted-foreground font-mono text-sm mt-1">
                  {bucketPrefix}
                </p>
              </>
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
            <h2 className="text-lg font-semibold">R2 Storage Files</h2>
            <p className="text-sm text-muted-foreground mt-1">
              {allFiles.length} {allFiles.length === 1 ? "file" : "files"} •{" "}
              {bucketPrefix}
            </p>
          </div>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>File Path</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Uploaded</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {allFiles.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={3}
                    className="text-center text-muted-foreground"
                  >
                    No files found in R2
                  </TableCell>
                </TableRow>
              ) : (
                allFiles.map((file, index) => (
                  <TableRow key={index} className="group">
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <a
                          href={`/sources/${sourceID}/files/${file.key}`}
                          className="font-mono text-sm text-blue-600 hover:text-blue-800 hover:underline"
                        >
                          {file.key}
                        </a>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatBytes(file.size)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(file.uploaded).toLocaleString()}
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
