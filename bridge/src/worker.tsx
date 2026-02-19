import { prefix, render, route } from "rwsdk/router";
import { defineApp } from "rwsdk/worker";

import { Document } from "@/app/document";
import { setCommonHeaders } from "@/app/headers";
import { Home } from "@/app/pages/home";
import { JobsPage } from "@/app/pages/admin/jobs";
import { apiRoutes } from "./api/routes";

export type AppContext = {};

export default defineApp([
  setCommonHeaders(),
  ({ ctx: _ctx }) => {
    // setup ctx here
  },
  prefix("/api", apiRoutes),
  render(Document, [route("/", Home), route("/admin/jobs", JobsPage)]),
]);
