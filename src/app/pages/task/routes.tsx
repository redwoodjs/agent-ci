import { route } from "rwsdk/router";

import { TaskDetailPage } from "./TaskDetailPage";
import { waitForContainer } from "@/app/components/WaitForContainer";

export const taskRoutes = [route("/", [waitForContainer, TaskDetailPage])];
