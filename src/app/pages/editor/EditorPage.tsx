import { requestInfo } from "rwsdk/worker";

import { Editor } from "./Editor";
import { FileBrowser } from "./FileBrowser";
import { fileType, getFile } from "./functions";
import { Preview } from "./Preview";

import { LazyTerm } from "@/app/components/Term/";

export const EditorPage = async ({ params }: { params: { port: string } }) => {
  const port = params.port;

  const url = new URL(requestInfo.request.url);
  let pathname = url.pathname;
  if (url.pathname.startsWith("/editor")) {
    pathname = pathname.split(`/editor/${port}`)[1];
    if (pathname.length === 0) {
      pathname = "/";
    }
  }

  const type = await fileType({ pathname, port });
  let content = "";
  if (type == "file") {
    const file = await getFile({ pathname, port });
    content = file.content;
  }

  return (
    <div className="h-screen flex bg-gray-800">
      <title>{pathname}</title>
      <div>
        <FileBrowser pathname={pathname} port={port} />
      </div>

      <div className="h-screen min-w-[800px]">
        <Editor pathname={pathname} initialContent={content} key={pathname} />
      </div>
      <div className="w-full flex flex-col bg-gray-400">
        <div className="flex flex-1">
          <div className="m-2 p-2 w-full rounded bg-white">
            <Preview port={port} />
          </div>
        </div>

        <div className="flex h-[400px] overflow-hidden">
          <div className="rounded w-full  m-2 p-2 bg-black">
            {/* <LazyTerm port={port} /> */}
          </div>
        </div>
      </div>
    </div>
  );
};
