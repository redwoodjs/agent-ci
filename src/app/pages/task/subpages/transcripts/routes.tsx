import { route } from "rwsdk/router";
import { waitForContainer } from "@/app/components/wait-for-container";
import { TranscriptPage } from "./transcript-page";

export const transcriptRoutes = [
  route("/", [waitForContainer, TranscriptPage]),
];
