import { route } from "rwsdk/router";

import { ProjectListPage } from "./ProjectListPage";
import { ProjectDetailPage } from "./ProjectDetailPage";
import { CreateProjectPage } from "./CreateProjectPage";

export const projectRoutes = [
  route("/", ProjectListPage),
  route("/create", CreateProjectPage),
  route("/:projectId", ProjectDetailPage),
];
