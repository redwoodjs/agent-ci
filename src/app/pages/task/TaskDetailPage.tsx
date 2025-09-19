import { type RequestInfo } from "rwsdk/worker";
import { env } from "cloudflare:workers";

import { TaskEditor } from "./components/TaskEditor";

import { db } from "@/db";
import { getSandbox } from "@cloudflare/sandbox";
import { getContextFile } from "@/lib/storage";

export async function TaskDetailPage({
  params,
}: {
  params: { containerId: string };
}) {
  const { containerId } = params;

  const { name: title } = await db
    .selectFrom("tasks")
    .where("containerId", "=", params.containerId)
    .select("name")
    .executeTakeFirstOrThrow();

  const overview = await getContextFile(containerId, "overview.md");
  const subtasks = await getContextFile(containerId, "subtasks.md");
  const transcript = await getContextFile(containerId, "transcript.json");
  const eOverview = await getContextFile(containerId, "enhanced_overview.md");
  const eSubtasks = await getContextFile(containerId, "enhanced_subtasks.md");

  const sandbox = await getSandbox(env.Sandbox, containerId);
  // await Promise.all([
  //   sandbox.writeFile("/machinen/task/overview.md", overview),
  //   sandbox.writeFile("/machinen/task/subtasks.md", subtasks),
  //   sandbox.writeFile("/machinen/task/transcript.json", transcript),
  //   sandbox.writeFile("/machinen/task/enhanced_overview.md", eOverview),
  //   sandbox.writeFile("/machinen/task/enhanced_subtasks.md", eSubtasks),
  // ]);

  return (
    <div>
      <TaskEditor
        containerId={containerId}
        initialData={{
          title,
          overview: overview,
          subtasks: subtasks,
        }}
        enhancedData={{
          overview: eOverview,
          subtasks: eSubtasks,
        }}
      />
    </div>
  );
}
