import { render, route, prefix } from "rwsdk/router";
import { defineApp } from "rwsdk/worker";

import { Document } from "@/app/document";
import { setCommonHeaders } from "@/app/headers";

import { Home } from "@/app/pages/home";
import { Compatibility } from "@/app/pages/compatibility";
import { sitemap } from "@/app/pages/sitemap";
import { blogRoutes } from "@/blog/routes";

export type AppContext = {};

export default defineApp([
  setCommonHeaders(),
  () => {
    // setup ctx here
  },
  // /sitemap.xml returns XML directly — not wrapped in <Document>.
  route("/sitemap.xml", () => sitemap()),
  render(Document, [
    route("/", Home),
    route("/compatibility", Compatibility),
    prefix("/blog", blogRoutes),
  ]),
]);
