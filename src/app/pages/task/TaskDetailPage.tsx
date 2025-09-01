import { type RequestInfo } from "rwsdk/worker";

import { WorkItem } from "./components/WorkItem";
// We will introduce a chat.
// The context of the markdown will be the prompt for the chat.

export function TaskDetailPage({
  params,
}: {
  params: { containerId: string };
}) {
  return (
    <div className="flex">
      <WorkItem containerId={params.containerId} />
    </div>
  );
}
