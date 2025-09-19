import { waitForContainer } from "@/app/components/wait-for-container";
import { route } from "rwsdk/router";

import { ChatPage } from "./ChatPage";

export const chatRoutes = [route("/", [waitForContainer, ChatPage])];
