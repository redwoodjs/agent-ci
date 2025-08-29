import { route } from "rwsdk/router";

import { TaskDetailPage } from "./TaskDetailPage";

export const taskRoutes = [route("/", TaskDetailPage)];
