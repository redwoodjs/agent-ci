import type { LayoutProps } from "rwsdk/router";

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
            <a href={`/task/${containerId}`}>Overview</a>
            {/* Consider renaming to Claude */}
            <a href={`/chat/${containerId}`}>Chat</a>
            <a href={`/logs/${containerId}`}>Logs</a>
            <a href={`/preview/${containerId}`}>Preview</a>
            <a href={`/editor/${containerId}`}>Editor</a>
            <a href={`/term/${containerId}`}>Term</a>
          </div>
        </div>
      </div>
      <div className="bg-background border mx-4">{children}</div>
    </div>
  );
};
