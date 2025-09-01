import { type RequestInfo } from "rwsdk/worker";

import { WorkItem } from "./components/WorkItem";
import { SystemPrompt } from "@/app/components/SystemPrompt";
// We will introduce a chat.
// The context of the markdown will be the prompt for the chat.

export function TaskDetailPage({
  params,
}: {
  params: { containerId: string };
}) {
  return (
    <div className="flex flex-col">
      <div className="p-4">
        <SystemPrompt containerId={params.containerId} />
      </div>
      <div className="flex flex-1">
        <WorkItem containerId={params.containerId} />
      </div>
    </div>
  );
}
