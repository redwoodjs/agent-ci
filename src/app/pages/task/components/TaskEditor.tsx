"use client";

import { useState } from "react";

import { Prompt } from "@/app/pages/chat/components/Prompt";
import { Button } from "@/app/components/ui/button";

import { enhanceTask } from "../actions";

export function TaskEditor({
  containerId,
  initialData,
}: {
  containerId: string;
  initialData: {
    title?: string;
    overview?: string;
    subtasks?: string;
  };
}) {
  const [title, setTitle] = useState(initialData.title ?? "");
  const [overview, setOverview] = useState(initialData.overview ?? "");
  const [subtasks, setSubtasks] = useState(initialData.subtasks ?? "");

  const [processId, setProcessId] = useState<string | null>(null);

  return (
    <div className="flex flex-row">
      <div className="flex-1">
        <div className="flex flex-1 gap-2">
          <input
            type="text"
            className="w-full text-2xl font-bold"
            value={title}
            placeholder="Issue Name"
            onChange={(e) => setTitle(e.target.value)}
          />
          <Button
            onClick={async () => {
              const result = await enhanceTask(containerId, overview, subtasks);
            }}
            variant="outline"
            className="justify-end flex-shrink-0"
          >
            Enhance Issue
          </Button>
        </div>

        <textarea
          className="flex-1 w-full"
          rows={10}
          value={overview}
          onChange={(e) => setOverview(e.target.value)}
        ></textarea>

        <h2 className="text-lg font-bold">Subtasks</h2>
        <textarea
          className="flex-1 w-full"
          rows={10}
          value={subtasks}
          onChange={(e) => setSubtasks(e.target.value)}
        ></textarea>

        <Button onClick={() => console.log("do so magic")} variant="outline">
          Save
        </Button>
      </div>

      <div className="flex flex-1 overflow-y-auto">
        <Prompt
          containerId={containerId}
          externalProcessId={processId || undefined}
          onExternalProcessComplete={async () => {
            // try {
            //   const [newContent, newTodo] = await Promise.all([
            //     getFileContent(containerId, "/.claude/ISSUE/CONTENT.md"),
            //     getFileContent(containerId, "/.claude/ISSUE/TODO.md"),
            //   ]);
            //   if (typeof newContent === "string") setOverview(newContent);
            //   if (typeof newTodo === "string") setSubtasks(newTodo);
            // } catch (err) {
            //   console.error("Failed to refresh issue files", err);
            // }
          }}
          seedUserMessage={`\
            Reference @/workspace/.claude/ISSUE/CONTENT.md, 
            @/workspace/.claude/ISSUE/TRANSCRIPT.md, 
            and @/workspace/.claude/ISSUE/TODO.md to know what we want to achieve.

            You may read the code in @/workspace, but do not modify any files, other than
            @/workspace/.claude/ISSUE/CONTENT.md, @/workspace/.claude/ISSUE/TRANSCRIPT.md, and @/workspace/.claude/ISSUE/TODO.md.
          `}
        />
      </div>
    </div>
  );
}
