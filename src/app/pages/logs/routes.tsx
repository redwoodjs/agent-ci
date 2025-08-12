import { route } from "rwsdk/router";

import { waitForContainer } from "@/app/components/WaitForContainer";

import { ProcessListPage } from "./ProcessListPage";
import { LogsPage } from "./LogsPage";
import { BootLogPage } from "./BootLogPage";

export const logsRoutes = [
  route("/:containerId/", [waitForContainer, ProcessListPage]),
  route("/:containerId/boot.log", [waitForContainer, BootLogPage]),
  route("/:containerId/:processId", [waitForContainer, LogsPage]),
];
