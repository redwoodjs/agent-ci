import { route } from "rwsdk/router";

import { EditorPage } from "./EditorPage";
import { waitForContainer } from "@/app/components/WaitForContainer";

export const editorRoutes = [route("/*", [waitForContainer, EditorPage])];
