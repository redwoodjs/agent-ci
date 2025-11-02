import { route, layout, prefix } from "rwsdk/router";

import { SourceListPage } from "./subpages/source-list-page";
import { SourceDetailPage } from "./subpages/source-detail-page";
import { SourceCreatePage } from "./subpages/source-create-page";
import { FilePreviewPage } from "./subpages/file-preview-page";
import { SourceLayout } from "./layout";

export const sourceRoutes = [
  route("/", SourceListPage),
  route("/new", SourceCreatePage),

  layout(SourceLayout, [
    route("/:sourceID", SourceDetailPage),
    route("/:sourceID/files/*", FilePreviewPage),
  ]),
];
