import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from "@/app/components/ui/card";
import { generateCodeTldr, fetchCodeTimeline } from "../actions";
import ReactMarkdown from "react-markdown";

export async function TldrSection({
  repo,
  commit,
  file,
  line,
  namespace,
  timelineResult,
}: {
  repo: string;
  commit: string;
  file: string;
  line: number;
  namespace: string | null;
  timelineResult?: Awaited<ReturnType<typeof fetchCodeTimeline>>;
}) {
  const result = await generateCodeTldr({
    repo,
    commit,
    file,
    line,
    namespace: namespace || undefined,
    timelineResult,
  });

  if (!result.success) {
    return (
      <Card className="border-red-500">
        <CardHeader>
          <CardTitle className="text-red-600">Error</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-red-600">{result.error}</p>
          {result.details && (
            <p className="text-sm text-gray-600 mt-2">{result.details}</p>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mb-12 overflow-hidden border border-slate-200 rounded-xl bg-white shadow-sm">
      <div className="bg-slate-50 border-b border-slate-200 px-6 py-4">
        <h3 className="text-xs font-bold text-slate-700 uppercase tracking-widest relative inline-block">
          Summary
          <div className="absolute -bottom-1 left-0 w-full h-1 bg-blue-500/30 rounded-full"></div>
        </h3>
      </div>
      <div className="px-6 py-8">
        <div className="prose max-w-none text-lg leading-relaxed text-gray-700">
          <ReactMarkdown>{result.tldr}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
