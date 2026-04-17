import { render, route, prefix } from "rwsdk/router";
import { defineApp } from "rwsdk/worker";

import { Document } from "@/app/document";
import { setCommonHeaders } from "@/app/headers";

import { Home } from "@/app/pages/home";
import { Compatibility } from "@/app/pages/compatibility";
import { sitemap } from "@/app/pages/sitemap";
import { serveMarkdownIfPreferred } from "@/app/lib/markdown-negotiation";
import homeMarkdown from "@/app/pages/home.md?raw";
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
    // Markdown negotiation: if the request Accept header prefers
    // `text/markdown`, serve the hand-authored markdown version of the
    // homepage; otherwise fall through to the React component.
    route("/", [serveMarkdownIfPreferred(homeMarkdown), Home]),
    route("/compatibility", Compatibility),
    prefix("/blog", blogRoutes),
  ]),
]);
