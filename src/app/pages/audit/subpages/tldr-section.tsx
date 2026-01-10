import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from "@/app/components/ui/card";
import { generateCodeTldr } from "./actions";

export async function TldrSection({
  repo,
  commit,
  file,
  line,
  namespace,
}: {
  repo: string;
  commit: string;
  file: string;
  line: number;
  namespace: string | null;
}) {
  const result = await generateCodeTldr({
    repo,
    commit,
    file,
    line,
    namespace: namespace || undefined,
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
    <div className="space-y-6">
      <Card className="border-l-4 border-l-blue-500">
        <CardHeader>
          <CardTitle className="text-2xl">TL;DR</CardTitle>
          <CardDescription>
            Quick summary of how this code evolved and why it exists
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="prose max-w-none">
            <p className="text-lg leading-relaxed whitespace-pre-wrap text-gray-700 wrap-break-word">
              {result.tldr}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
