"use client";

import { ArrowLeft, Download } from "lucide-react";
import { Button } from "@/app/components/ui/button";

export function PageHeader({
  title,
  backUrl,
}: {
  title: string;
  backUrl: string;
}) {
  return (
    <div className="border-b bg-white border-gray-200 px-6 py-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <a href={backUrl} className="w-4 h-4">
            <ArrowLeft className="w-4 h-4" />
          </a>

          <div className="flex items-center gap-3">
            <h1 className="text-xl">{title}</h1>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2"></div>
          {/* 
          <Button variant="outline" size="sm">
            <Download className="w-4 h-4 mr-2" />
            Install MCP
          </Button> */}
        </div>
      </div>
    </div>
  );
}
