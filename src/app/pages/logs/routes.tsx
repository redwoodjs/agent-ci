import { route } from "rwsdk/router";

import { waitForContainer } from "@/app/components/WaitForContainer";

import { ProcessListPage } from "./ProcessListPage";
import { LogsPage } from "./LogsPage";

export const logsRoutes = [
  route("/", [waitForContainer, ProcessListPage]),
  route("/:processId", [waitForContainer, LogsPage]),
];
