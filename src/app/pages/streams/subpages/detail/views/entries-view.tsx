import { Badge } from "@/app/components/ui/badge";
import { Stream } from "../../../types";
import { ExternalLink } from "lucide-react";

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

const mockFiles: FileItem[] = [
  {
    filePath: "src/app/pages/streams/subpages/detail/views/entries-view.tsx",
    repoUrl:
      "https://github.com/redwoodjs/machinen/blob/main/src/app/pages/streams/subpages/detail/views/entries-view.tsx",
    entries: [
      {
        lineStart: 33,
        lineEnd: 45,
        subjects: ["Entries UI", "Server Components"],
        excerptText:
          'export async function EntriesView({ stream }: EntriesViewProps) {\n  // server-rendered list using mock data\n  return (\n    <div className="flex-1 p-6 bg-white">\n      <div className="max-w-7xl mx-auto">',
      },
    ],
  },
  {
    filePath: "src/lib/assemble.ts",
    repoUrl:
      "https://github.com/redwoodjs/machinen/blob/main/src/lib/assemble.ts",
    entries: [
      {
        lineStart: 13,
        lineEnd: 24,
        subjects: ["Segments", "Evidence Lines"],
        excerptText:
          "export interface StructuredSeg {\n  title: string;\n  summary: string;\n  entities: string[];\n  actions: string[];\n  decisions: string[];\n  tags: string[];\n  evidence_turns: number[];",
      },
    ],
  },
];

function CodeExcerpt({ entry }: { entry: FileEntry }) {
  const lines = entry.excerptText.split("\n");
  const total = entry.lineEnd - entry.lineStart + 1;
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
  const files = mockFiles;

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
