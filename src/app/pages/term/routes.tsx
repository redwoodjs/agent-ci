import { env } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";

import { route } from "rwsdk/router";
import { waitForContainer } from "@/app/components/WaitForContainer";
import { TermPage } from "./TermPage";

export const termRoutes = [
  route("/", [waitForContainer, TermPage]),
  route("/attach", [
    waitForContainer,
    async ({ request, params }) => {
      const url = new URL(request.url);
      url.port = "8910";
      const newRequest = new Request(url, request);
      const container = await getSandbox(env.Sandbox, params.containerId);
      return await container.fetch(newRequest);
    },
  ]),
];
