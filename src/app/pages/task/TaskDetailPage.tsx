import { type RequestInfo } from "rwsdk/worker";
import { env } from "cloudflare:workers";

import { TaskEditor } from "./components/TaskEditor";

import { db } from "@/db";
import { getSandbox } from "@cloudflare/sandbox";

export async function TaskDetailPage({
  params,
}: {
  params: { containerId: string };
}) {
  const { containerId } = params;

  // we have to fetch the task from the database.
  const { name: title, id } = await db
    .selectFrom("tasks")
    .where("containerId", "=", params.containerId)
    .select("name")
    .select("id")
    .executeTakeFirstOrThrow();

  const bucketPrefix = `${containerId}/${id}`;
  const overview = await env.CONTEXT_STREAM.get(`${bucketPrefix}/OVERVIEW.md`);
  const subtasks = await env.CONTEXT_STREAM.get(`${bucketPrefix}/SUBTASKS.md`);

  // get the enhanced notes from the sandbox
  const sandbox = await getSandbox(env.Sandbox, containerId);
  const enhancedOverview = await sandbox.readFile(`/machinen/OVERVIEW.md`);
  const enhancedSubtasks = await sandbox.readFile(`/machinen/SUBTASKS.md`);

  return (
    <div>
      <TaskEditor
        containerId={containerId}
        initialData={{
          title,
          overview: await overview?.text(),
          subtasks: await subtasks?.text(),
        }}
        enhancedData={{
          overview: enhancedOverview.content,
          subtasks: enhancedSubtasks.content,
        }}
      />
    </div>
  );
}
