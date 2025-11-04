import { route, layout } from "rwsdk/router";

import { SourceListPage } from "./subpages/source-list-page";
import { SourceDetailPage } from "./subpages/source-detail-page";
import { SourceCreatePage } from "./subpages/source-create-page";
import { FilePreviewPage } from "./subpages/file-preview-page";
import { SourceLayout, SourceListLayout, SourceCreateLayout } from "./layout";
import { requireAuth } from "../auth/interruptors";

export const sourceRoutes = [
  requireAuth,
  layout(SourceListLayout, [route("/", SourceListPage)]),
  layout(SourceCreateLayout, [route("/new", SourceCreatePage)]),
  layout(SourceLayout, [
    route("/:sourceID", SourceDetailPage),
    route("/:sourceID/browse/*", SourceDetailPage),
    route("/:sourceID/files/*", FilePreviewPage),
  ]),
];
