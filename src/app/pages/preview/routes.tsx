import { route } from "rwsdk/router";

import { waitForContainer } from "@/app/components/WaitForContainer";
import { PreviewPage } from "./PreviewPage";

export const previewRoutes = [route("/*", [waitForContainer, PreviewPage])];
