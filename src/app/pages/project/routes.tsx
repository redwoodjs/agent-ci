import { route } from "rwsdk/router";

import { ProjectListPage } from "./ProjectListPage";
import { ProjectDetailPage } from "./ProjectDetailPage";
import { CreateProjectPage } from "./CreateProjectPage";

export const projectRoutes = [
  route("/", ProjectListPage),
  route("/:projectId", ProjectDetailPage),
  route("/create", CreateProjectPage),
];
