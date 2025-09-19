import { route } from "rwsdk/router";

import { EditorPage } from "./EditorPage";
import { waitForContainer } from "@/app/components/wait-for-container";

export const editorRoutes = [route("*", [waitForContainer, EditorPage])];
