import { route, prefix } from "rwsdk/router";

import { StreamsListPage } from "./streams-list-page";
import { detailRoutes } from "./subpages/detail/routes";

export const streamRoutes = [
  route("/", StreamsListPage),
  prefix("/:streamID", detailRoutes),
];