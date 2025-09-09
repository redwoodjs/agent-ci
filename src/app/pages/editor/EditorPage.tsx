import { getFileType, getFileContent, getFiles } from "./actions";

import { Editor } from "./components/MonacoEditorContainer";
import { FileBrowser } from "./components/FileBrowser";
import { Preview } from "@/app/components/Preview";

import { LazyTerm } from "@/app/components/LazyTerm";

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
    </div>
  );
};
