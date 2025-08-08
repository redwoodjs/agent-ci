import { route } from "rwsdk/router";

import { EditorPage } from "./EditorPage";
import { waitForContainer } from "@/app/components/WaitForContainer/interruptor";

export const editorRoutes = [
  route("/:containerId*", async function (opts) {
    const r = await waitForContainer(opts);
    if (r) {
      return r;
    }
    return <EditorPage params={opts.params} />;
  }),
];
