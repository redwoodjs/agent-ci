"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import { LogViewer } from "./log-viewer";

export function ReplayRunLogText({ text }: { text: string }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-lg">Text log</CardTitle>
      </CardHeader>
      <CardContent>
        <LogViewer text={text} label="Copy" />
      </CardContent>
    </Card>
  );
}
