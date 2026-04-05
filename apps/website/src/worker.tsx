import { render, route, prefix } from "rwsdk/router";
import { defineApp } from "rwsdk/worker";

import { Document } from "@/app/document";
import { setCommonHeaders } from "@/app/headers";

import { Home } from "@/app/pages/home";
import { Compatibility } from "@/app/pages/compatibility";
import { blogRoutes } from "@/blog/routes";

export type AppContext = {};

export default defineApp([
  setCommonHeaders(),
  () => {
    // setup ctx here
  },
  render(Document, [
    route("/", Home),
    route("/compatibility", Compatibility),
    prefix("/blog", blogRoutes),
  ]),
]);
