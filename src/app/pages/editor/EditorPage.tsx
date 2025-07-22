import { requestInfo } from "rwsdk/worker";

import { Editor } from "./Editor";
import { FileBrowser } from "./FileBrowser";
import { fileType, getFile, getSiblingFiles } from "./functions";
import { Preview } from "./Preview";

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
      <div>
        <FileBrowser
          files={files}
          pathname={pathname}
          containerId={containerId}
        />
      </div>

      <div className="h-screen min-w-[800px]">
        <Editor
          pathname={pathname}
          containerId={containerId}
          initialContent={content}
          key={pathname}
        />
      </div>
      <div className="w-full flex flex-col bg-gray-400">
        <div className="flex flex-1">
          <div className="m-2 p-2 w-full rounded bg-white">
            <Preview containerId={containerId} />
          </div>
        </div>

        <div className="flex h-[400px] overflow-hidden">
          <div className="rounded w-full  m-2 p-2 bg-black">
            <LazyTerm containerId={containerId} />
          </div>
        </div>
      </div>
    </div>
  );
};
