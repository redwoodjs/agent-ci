import { getSandbox } from "@cloudflare/sandbox";
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
      url.port = "5173";
      url.hostname = "8910-blog.localhost";
      url.pathname = url.pathname.replace(
        `/term/${params.containerId}`,
        "/tty"
      );

      // const container = getContainer(env.Sandbox, params.containerId);

      // const newRequest = new Request(url, request);
      // const response = await container.fetch(url, request);
      console.log("*".repeat(80));
      console.log(url);
      console.log("*".repeat(80));

      const response = await fetch(url, request);

      console.log("*".repeat(80));
      console.log(url);
      console.log(response);
      console.log("*".repeat(80));

      return response;
    },
  ]),
];
