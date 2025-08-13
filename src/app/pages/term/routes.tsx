import { route } from "rwsdk/router";
import { waitForContainer } from "@/app/components/WaitForContainer";

export const termRoutes = [
  route("/:containerId/attach", [
    waitForContainer,
    async ({ request, params }) => {
      const url = new URL(request.url);
      url.pathname = url.pathname.replace(`/tty/${params.containerId}`, "/tty");

      // const response = await fetchContainer({
      //   containerId: params.containerId,
      //   request: new Request(url, request),
      // });
      // return response;
    },
  ]),
];
