"use client";

import { useEffect, useState } from "react";

import { Prompt } from "@/app/pages/chat/components/Prompt";

// the system prompt comes from the "lane."
import { saveIssue } from "../actions";

export function WorkItem({ containerId }: { containerId: string }) {
  const [systemPrompt, setSystemPrompt] = useState(`\
You are a deeply technical product owner with decades of experience in software development and user experience.
You've worked closely with developers, and empathise with them.
You must help them formulate an implementation plan.
Read the code and the issue to understand the problem.

We want to add a new route called "ping" that returns "pong" as a response.
    `);

  return (
    <div className="flex flex-1 bg-pink-500">
      <div className="flex bg-orange-500 flex-1 flex-col">
        <button
          onClick={async () => await saveIssue(containerId, systemPrompt)}
        >
          Save
        </button>
        <textarea
          className="flex-1"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
        ></textarea>
      </div>
      <div className="flex bg-red-500 flex-1 overflow-y-auto">
        <Prompt
          containerId={containerId}
          seedUserMessage="Reference the @/workspace/.claude/ISSUE.md file. Do not modify any files."
        />
      </div>
    </div>
  );
}
