import { route, layout, prefix } from "rwsdk/router";

import { SourceListPage } from "./subpages/source-list-page";
import { SourceDetailPage } from "./subpages/source-detail-page";
import { SourceLayout } from "./layout";

export const sourceRoutes = [
  route("/", SourceListPage),

  layout(SourceLayout, [route("/:sourceID", SourceDetailPage)]),
];
