import { route, prefix, layout } from "rwsdk/router";

import { StreamsListPage } from "./streams-page";

import { StreamLayout } from "./layout";

import { AskPage } from "./subpages/ask/ask-page";
import { ArtifactsPage } from "./subpages/artifacts/artifacts-page";
import { ArtifactDetailPage } from "./subpages/artifacts/artifacts-detail-page";
import { SubjectsPage } from "./subpages/subjects/subjects-page";
import { SourcesPage } from "./subpages/sources/sources-page";

export const streamRoutes = [
  route("/", StreamsListPage),

  prefix("/:streamID", [
    layout(StreamLayout, [
      route("/ask", ({ params }) => <AskPage params={params} />),
      route("/artifacts", ArtifactsPage),
      route("/artifacts/:artifactID", ArtifactDetailPage),
      // TODO: Rename to subscriptions.
      route("/subjects", SubjectsPage),
      route("/sources", SourcesPage),
    ]),
  ]),
];
