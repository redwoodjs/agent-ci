import { type RequestInfo } from "rwsdk/worker";

// TODO: Rename this to "Issue.""
import { WorkItem } from "./components/WorkItem";
import { SystemPrompt } from "@/app/components/SystemPrompt";

import { db } from "@/db";

export async function TaskDetailPage({
  params,
}: {
  params: { containerId: string };
}) {
  // we have to fetch the task from the database.
  const { name } = await db
    .selectFrom("tasks")
    .where("containerId", "=", params.containerId)
    .select("name")
    .executeTakeFirstOrThrow();

  return (
    <div>
      <WorkItem containerId={params.containerId} name={name} />
    </div>
  );
}
