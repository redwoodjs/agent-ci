import { type RequestInfo } from "rwsdk/worker";
import { env } from "cloudflare:workers";

import { TaskEditor } from "./components/TaskEditor";

import { db } from "@/db";

export async function TaskDetailPage({
  params,
}: {
  params: { containerId: string };
}) {
  const { containerId } = params;

  // we have to fetch the task from the database.
  const { name: title, laneId } = await db
    .selectFrom("tasks")
    .where("containerId", "=", params.containerId)
    .select("name")
    .select("laneId")
    .executeTakeFirstOrThrow();

  const bucketPrefix = `${containerId}/${laneId}`;

  const overview = await env.CONTEXT_STREAM.get(`${bucketPrefix}/OVERVIEW.md`);
  const subtasks = await env.CONTEXT_STREAM.get(`${bucketPrefix}/SUBTASKS.md`);

  return (
    <div>
      <TaskEditor
        containerId={containerId}
        initialData={{
          title,
          overview: await overview?.text(),
          subtasks: await subtasks?.text(),
        }}
      />
    </div>
  );
}
