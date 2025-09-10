"use client";

import { useEffect, useState } from "react";

import { Prompt } from "@/app/pages/chat/components/Prompt";
import { Button } from "@/app/components/ui/button";
// the system prompt comes from the "lane."
import { enhanceIssue, saveIssue } from "../actions";

export function WorkItem({
  containerId,
  name,
}: {
  containerId: string;
  name: string;
}) {
  const [issueName, setIssueName] = useState(name);
  const [issueContent, setIssueContent] = useState(`\
We want to enhance the issue to add a new route called "ping" that returns "pong" as a response.
    `);

  return (
    <div className="flex flex-row">
      <div className="flex-1">
        <div className="flex flex-1 gap-2">
          <input
            type="text"
            className="w-full text-2xl font-bold"
            value={issueName}
            placeholder="Issue Name"
            onChange={(e) => setIssueName(e.target.value)}
          />
          <Button
            onClick={async () => await enhanceIssue(containerId, issueContent)}
            variant="outline"
            className="justify-end flex-shrink-0"
          >
            Enhance Issue
          </Button>
        </div>

        <textarea
          className="flex-1 w-full"
          rows={10}
          value={issueContent}
          onChange={(e) => setIssueContent(e.target.value)}
        ></textarea>

        <h2 className="text-lg font-bold">Sub tasks ("The plan")</h2>
        <ol className="list-decimal list-inside">
          <li>
            Add a new route called "ping" that returns "pong" as a response.
          </li>
          <li>Return a response code of 200.</li>
        </ol>

        <Button onClick={() => console.log("do so magic")} variant="outline">
          Save
        </Button>
      </div>

      <div className="flex flex-1 overflow-y-auto">
        <Prompt
          containerId={containerId}
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
