import { route, prefix, layout } from "rwsdk/router";

import { StreamsListPage } from "./streams-list-page";

import { StreamLayout } from "./layout";
import { SourcesPage } from "./subpages/sources-page";

export const streamRoutes = [
  route("/", StreamsListPage),

  prefix("/:streamID", [
    layout(StreamLayout, [
      // route("/ask", AskPage),
      route("/sources", SourcesPage),
    ]),
  ]),
];
