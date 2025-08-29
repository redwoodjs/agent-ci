import { waitForContainer } from "@/app/components/WaitForContainer";
import { route } from "rwsdk/router";

import { ChatPage } from "./ChatPage";

export const chatRoutes = [route("/", [waitForContainer, ChatPage])];
