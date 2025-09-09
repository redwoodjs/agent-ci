import { route } from "rwsdk/router";
import { DoExplore } from "./pages/DoExplore";

export const doExploreRoutes = [
  route("/", DoExplore),
  route("/:table", DoExplore),
];