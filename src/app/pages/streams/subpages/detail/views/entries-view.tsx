import { Badge } from "@/app/components/ui/badge";
import { Stream } from "../../../types";
import { ExternalLink } from "lucide-react";
import { db } from "@/db";

interface EntriesViewProps {
  stream: Stream;
}

interface FileEntry {
  lineStart: number;
  lineEnd: number;
  subjects: string[];
  excerptText: string;
}

interface FileItem {
  filePath: string;
  repoUrl?: string;
  entries: FileEntry[];
}

type DbEntryRow = {
  id: string;
  source_id: string;
  bucket_path: string;
  subject_id: string;
  ranges: string;
  created_at: string;
  updated_at: string;
};

function CodeExcerpt({ entry }: { entry: FileEntry }) {
  const total = entry.lineEnd - entry.lineStart + 1;
  const baseLines = entry.excerptText ? entry.excerptText.split("\n") : [];
  const lines = baseLines.length > 0 ? baseLines : Array(total).fill("");
  const numbers = Array.from({ length: total }, (_, i) => entry.lineStart + i);

  return (
    <div className="mt-2 border rounded bg-gray-50">
      <div className="font-mono text-xs">
        {lines.map((line, idx) => (
          <div key={idx} className="flex">
            <div className="w-12 shrink-0 text-right pr-3 py-0.5 text-gray-400 border-r">
              {numbers[idx] ?? ""}
            </div>
            <pre className="m-0 px-3 py-0.5 whitespace-pre-wrap flex-1 bg-yellow-50">
              {line}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}

export async function EntriesView({ stream }: EntriesViewProps) {
  const rows = (await db
    .selectFrom("entries")
    .selectAll()
    .execute()) as DbEntryRow[];

  const byPath = new Map<string, FileItem>();
  for (const row of rows) {
    let parsed: any = [];
    try {
      parsed = JSON.parse(row.ranges);
    } catch {}

    const normalized: FileEntry[] = Array.isArray(parsed)
      ? parsed.map((r: any) => ({
          lineStart:
            typeof r?.lineStart === "number"
              ? r.lineStart
              : Array.isArray(r)
              ? r[0] ?? 0
              : 0,
          lineEnd:
            typeof r?.lineEnd === "number"
              ? r.lineEnd
              : Array.isArray(r)
              ? r[1] ?? 0
              : 0,
          subjects: [row.subject_id],
          excerptText: typeof r?.excerptText === "string" ? r.excerptText : "",
        }))
      : [];

    if (!byPath.has(row.bucket_path)) {
      byPath.set(row.bucket_path, {
        filePath: row.bucket_path,
        entries: [],
      });
    }

    const item = byPath.get(row.bucket_path)!;
    for (const entry of normalized) {
      const existing = item.entries.find(
        (e) => e.lineStart === entry.lineStart && e.lineEnd === entry.lineEnd
      );
      if (existing) {
        const set = new Set([...existing.subjects, ...entry.subjects]);
        existing.subjects = Array.from(set);
        if (!existing.excerptText && entry.excerptText)
          existing.excerptText = entry.excerptText;
      } else {
        item.entries.push(entry);
      }
    }
  }

  const files = Array.from(byPath.values());

  return (
    <div className="flex-1 p-6 bg-white">
      <div className="max-w-7xl mx-auto">
        <div className="mb-6">
          <h2 className="text-xl font-semibold mb-2">Entries</h2>
          <p className="text-muted-foreground">
            Files with important line ranges associated to subjects.
          </p>
        </div>

        <div className="space-y-6">
          {files.map((file) => (
            <div key={file.filePath} className="border rounded-lg p-4">
              <div className="flex items-center gap-2 text-sm font-mono">
                <span className="text-gray-700">{file.filePath}</span>
                {file.repoUrl && (
                  <a
                    href={file.repoUrl}
                    target="_blank"
                    className="text-gray-500 hover:text-gray-700"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
              </div>

              <div className="mt-3 space-y-4">
                {file.entries.map((entry, idx) => (
                  <div key={idx}>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-gray-500">
                        L{entry.lineStart}–{entry.lineEnd}
                      </span>
                      <span className="text-gray-300">•</span>
                      <div className="flex flex-wrap gap-1.5">
                        {entry.subjects.map((s) => (
                          <Badge key={s} variant="outline">
                            {s}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <CodeExcerpt entry={entry} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
