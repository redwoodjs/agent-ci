import { route } from "rwsdk/router";
import { AskPage } from "./ask-page";
import { SourcesPage } from "./sources-page";
import { TimelinePage } from "./timeline-page";
import { SubjectsPage } from "./subjects-page";

export const detailRoutes = [
  route("/ask", AskPage),
  route("/sources", SourcesPage),
  route("/timeline", TimelinePage),
  route("/subjects", SubjectsPage),
];