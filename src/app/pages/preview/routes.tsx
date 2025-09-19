import { route } from "rwsdk/router";

import { waitForContainer } from "@/app/components/wait-for-container";
import { PreviewPage } from "./PreviewPage";

export const previewRoutes = [route("*", [waitForContainer, PreviewPage])];
