import { getFileType, getFileContent, getFiles } from "./actions";

import { Editor } from "./components/MonacoEditorContainer";
import { FileBrowser } from "./components/FileBrowser";
import { Preview } from "@/app/components/Preview";

import { LazyTerm } from "@/app/components/Term/";

export const EditorPage = async ({
  params,
}: {
  params: { containerId: string; $0: string };
}) => {
  const { containerId, $0: pathname } = params;

  const type = await getFileType(containerId, pathname);

  let content = "";
  if (type === "file") {
    content = await getFileContent(containerId, pathname);
  }

  let listPathname = pathname;
  if (type === "file") {
    listPathname = pathname.split("/").slice(0, -1).join("/");
  }
  const files = await getFiles(containerId, listPathname);

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

      {/* Right Side - Preview and Terminal */}
      <div className="w-96 flex flex-col border-l border-gray-700">
        {/* Top Right - Preview */}
        <div className="flex-1 border-b border-gray-700">
          <div className="h-full m-2 p-2 bg-white rounded">
            <Preview containerId={containerId} />
          </div>
        </div>

        {/* Bottom Right - Terminal */}
        <div className="h-96">
          <div className="h-full m-2 p-2 bg-black rounded">
            {/* <LazyTerm containerId={containerId} /> */}
          </div>
        </div>
      </div>
    </div>
  );
};
