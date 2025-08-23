import { getSandbox } from "@cloudflare/sandbox";
import { getContainer, switchPort } from "@cloudflare/containers";
import { getContainer } from "@cloudflare/containers";

import { env } from "cloudflare:workers";

import { route } from "rwsdk/router";
import { waitForContainer } from "@/app/components/WaitForContainer";
import { TermPage } from "./TermPage";

export const termRoutes = [
  route("/:containerId", [waitForContainer, TermPage]),
  route("/:containerId/attach", [
    waitForContainer,
    async ({ request, params }) => {
      const url = new URL(request.url);
      url.port = "8910";

      console.log("constructed a url", url.toString());

      const newRequest = new Request(url, request);
      // This appears to send all requests to the bun server.
      const container = await getContainer(env.Sandbox, params.containerId);
      console.log("got container");

      const response = await container.fetch(switchPort(newRequest, 8910));
      console.log("got a response", response.status);

      return response;
    },
  ]),
];
