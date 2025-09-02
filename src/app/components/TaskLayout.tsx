import type { LayoutProps } from "rwsdk/router";
import { link } from "../shared/links";

export const TaskLayout = ({ children, requestInfo }: LayoutProps) => {
  if (!requestInfo) {
    throw new Error("requestInfo is required");
  }

  const { containerId } = requestInfo.params;

  return (
    <div>
      <div className="flex">
        <div className="w-4 h-4 line-height-4 border-b border-dashed">M</div>
        <div className="border-l border-dashed">
          <div className="flex gap-2 px-4">
            <a href={link("/tasks/:containerId", { containerId })}>Overview</a>
            <a href={link("/tasks/:containerId/chat", { containerId })}>Chat</a>
            <a href={link("/tasks/:containerId/logs", { containerId })}>Logs</a>
            <a href={link("/tasks/:containerId/preview", { containerId })}>
              Preview
            </a>
            <a href={link("/tasks/:containerId/editor", { containerId })}>
              Editor
            </a>
            <a href={link("/tasks/:containerId/term", { containerId })}>Term</a>
          </div>
        </div>
      </div>
      <div className="bg-background border mx-4">{children}</div>
    </div>
  );
};
