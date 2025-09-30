import { route, prefix, layout } from "rwsdk/router";

import { StreamsListPage } from "./streams-list-page";

import { StreamLayout } from "./layout";

import { ArtifactsPage } from "./subpages/artifacts/artifacts-page";
import { SubjectsPage } from "./subpages/subjects/subjects-page";
import { SourcesPage } from "./subpages/sources-page";

export const streamRoutes = [
  route("/", StreamsListPage),

  prefix("/:streamID", [
    layout(StreamLayout, [
      route("/", () => {
        return new Response(null, {
          status: 302,
          headers: { Location: "/entries" },
        });
      }),
      route("/artifacts", ArtifactsPage),
      // TODO: Rename to subscriptions.
      route("/subjects", SubjectsPage),
      route("/sources", SourcesPage),
    ]),
  ]),
];
