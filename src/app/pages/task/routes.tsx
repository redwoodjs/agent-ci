import { route } from "rwsdk/router";

import { TaskDetailPage } from "./TaskDetailPage";
import { waitForContainer } from "@/app/components/wait-for-container";

export const taskRoutes = [route("/", [waitForContainer, TaskDetailPage])];
