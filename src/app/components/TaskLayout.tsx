import type { LayoutProps } from "rwsdk/router";

import { AudioMeeting } from "./AudioMeeting";
import { link } from "../shared/links";
import { Presence } from "./Presence";

export const TaskLayout = ({ children, requestInfo }: LayoutProps) => {
  if (!requestInfo) {
    throw new Error("requestInfo is required");
  }

  const { containerId } = requestInfo.params;

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
              <a href={link("/tasks/:containerId/chat", { containerId })}>
                Transcript
              </a>
              <a href={link("/tasks/:containerId/chat", { containerId })}>
                Chat
              </a>
              <a href={link("/tasks/:containerId/logs", { containerId })}>
                Logs
              </a>
              <a href={link("/tasks/:containerId/preview", { containerId })}>
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
