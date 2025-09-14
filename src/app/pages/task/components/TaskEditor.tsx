"use client";

import { useState } from "react";

import { Prompt } from "@/app/pages/chat/components/Prompt";
import { Button } from "@/app/components/ui/button";

import { enhanceTask, saveTask } from "../actions";

export function TaskEditor({
  containerId,
  initialData,
  enhancedData,
}: {
  containerId: string;
  initialData: {
    title?: string;
    overview?: string;
    subtasks?: string;
  };
  enhancedData: {
    overview?: string;
    subtasks?: string;
  };
}) {
  const [title, setTitle] = useState(initialData.title ?? "");
  const [overview, setOverview] = useState(initialData.overview ?? "");
  const [subtasks, setSubtasks] = useState(initialData.subtasks ?? "");

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

        <div className="flex flex-row gap-2">
          <textarea
            className="flex-1"
            rows={10}
            value={overview}
            onChange={(e) => setOverview(e.target.value)}
          ></textarea>
          <div className="flex-1 border border-red-500">
            {enhancedData?.overview ?? "none"}
          </div>
        </div>

        <h2 className="text-lg font-bold">Subtasks</h2>
        <div className="flex flex-row gap-2">
          <textarea
            className="flex-1 w-full"
            rows={10}
            value={subtasks}
            onChange={(e) => setSubtasks(e.target.value)}
          ></textarea>
          <div className="flex-1 border border-red-500">
            {enhancedData?.subtasks ?? "none"}
          </div>
        </div>

        <Button
          onClick={async () => {
            await saveTask(containerId, overview, subtasks);
          }}
          variant="outline"
        >
          Save
        </Button>
      </div>

      <div className="flex flex-1 overflow-y-auto">
        <Prompt
          containerId={containerId}
          seedUserMessage={`\
            Reference:
            - @/machinen/OVERVIEW.md
            - @/machinen/SUBTASKS.md

            Code is in: @/workspace/
          `}
        />
      </div>
    </div>
  );
}
