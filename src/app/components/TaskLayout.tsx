import type { LayoutProps } from "rwsdk/router";

import { AudioMeeting } from "./AudioMeeting";
import { link } from "../shared/links";
import { Presence } from "./Presence";
import { db } from "@/db";

export const TaskLayout = async ({ children, requestInfo }: LayoutProps) => {
  if (!requestInfo) {
    throw new Error("requestInfo is required");
  }

  const { containerId } = requestInfo.params;

  const { exposePorts } = await db
    .selectFrom("tasks")
    .where("containerId", "=", containerId)
    .innerJoin("projects", "tasks.projectId", "projects.id")
    .select("projects.exposePorts")
    .executeTakeFirstOrThrow();

  return (
    <div>
      <div className="flex">
        <div className="w-4 h-8 line-height-4 border-b border-dashed">M</div>

        <div className="flex-1 bg-red-100 flex">
          <div className="border-l border-dashed flex gap-2">
            {/* <Presence containerId={containerId} /> */}
            {/* <AudioMeeting containerId={containerId} /> */}
            <div className="flex flex-1 gap-2 px-4">
              <a href={link("/tasks/:containerId", { containerId })}>Issue</a>
              <a href={link("/tasks/:containerId/transcript", { containerId })}>
                Transcript
              </a>
              <a href={link("/tasks/:containerId/chat", { containerId })}>
                Chat
              </a>
              <a href={link("/tasks/:containerId/logs", { containerId })}>
                Logs
              </a>

              <a
                href={`http://${exposePorts}-${containerId}.localhost:5173`}
                target="_blank"
              >
                Preview
              </a>
              <a href={link("/tasks/:containerId/editor", { containerId })}>
                Files
              </a>
              <a href={link("/tasks/:containerId/term", { containerId })}>
                Terminal
              </a>
            </div>
          </div>
          <div className="flex flex-1 justify-end">
            {requestInfo.ctx.user?.email}
            <a href="/auth/logout">Logout</a>
          </div>
        </div>
      </div>
      <div className="bg-background border mx-4">{children}</div>
    </div>
  );
};
