import { route } from "rwsdk/router";

import { ProcessListPage } from "./ProcessListPage";
import { LogsPage } from "./LogsPage";
import { waitForContainer } from "@/app/components/WaitForContainer/interruptor";

export const logsRoutes = [
  route("/:containerId/", async function (opts) {
    const r = await waitForContainer(opts);
    if (r) {
      return r;
    }
    return <ProcessListPage params={opts.params} />;
  }),
  route("/:containerId/:processId", [LogsPage]),
];
