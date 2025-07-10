import { requestInfo } from "rwsdk/worker";

import { Editor } from "./Editor";
import { FileBrowser } from "./FileBrowser";
import { fileType, getFile, getSiblingFiles } from "./functions";
import { Preview } from "./Preview";
import { ClaudePanel } from "./ClaudePanel";

import { LazyTerm } from "@/app/components/Term/";

export const EditorPage = async ({
  params,
}: {
  params: { containerId: string };
}) => {
  const containerId = params.containerId;

  const url = new URL(requestInfo.request.url);
  let pathname = url.pathname;
  if (url.pathname.startsWith("/editor")) {
    pathname = pathname.split(`/editor/${containerId}`)[1];
    if (pathname.length === 0) {
      pathname = "/";
    }
  }

  const type = await fileType({ pathname, containerId });
  let content = "";
  if (type == "file") {
    const file = await getFile({ pathname, containerId });
    content = file.content;
  }

  const files = await getSiblingFiles({ pathname, containerId });

  return (
    <div className="h-screen flex bg-gray-800">
      <title>{pathname}</title>
      
      {/* File Browser - Left Panel */}
      <div className="w-64 border-r border-gray-700">
        <FileBrowser
          files={files}
          pathname={pathname}
          containerId={containerId}
        />
      </div>

      {/* Code Editor - Center Panel */}
      <div className="flex-1 min-w-[400px]">
        <Editor
          pathname={pathname}
          containerId={containerId}
          initialContent={content}
          key={pathname}
        />
      </div>
      
      {/* Right Side - Split between Preview/Terminal and Claude */}
      <div className="w-96 flex flex-col border-l border-gray-700">
        {/* Top Right - Preview */}
        <div className="flex-1 border-b border-gray-700">
          <div className="h-full m-2 p-2 bg-white rounded">
            <Preview containerId={containerId} />
          </div>
        </div>

        {/* Bottom Right - Split between Terminal and Claude */}
        <div className="h-96 flex">
          {/* Terminal Panel */}
          <div className="flex-1 border-r border-gray-700">
            <div className="h-full m-2 p-2 bg-black rounded">
              <LazyTerm containerId={containerId} />
            </div>
          </div>
          
          {/* Claude Panel */}
          <div className="flex-1">
            <div className="h-full m-2 rounded overflow-hidden">
              <ClaudePanel />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
