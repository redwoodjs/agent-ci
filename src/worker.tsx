import { defineApp } from "rwsdk/worker";
import { route, render } from "rwsdk/router";
import { Document } from "@/app/Document";

import { EditorPage } from "@/app/pages/editor/EditorPage";
import { TermPage } from "@/app/pages/TermPage";
import { fetchContainer } from "./container";
import { SessionPage } from "./app/pages/session/SessionPage";

export default defineApp([
  render(Document, [
    route("/", () => {
      return <SessionPage />;
    }),
    route("/editor/:port", EditorPage),
    route("/editor/:port/*", EditorPage),
    route("/term", TermPage),
  ]),

  route("/preview/:port*", async ({ request, params }) => {
    // Create a new URL with the modified pathname
    const url = new URL(request.url);
    url.pathname = url.pathname.replace(`/preview/${params.port}`, "");
    url.port = params.port;

    // Create a new Request object with the modified URL
    const modifiedRequest = new Request(url.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: request.redirect,
      signal: request.signal,
    });

    console.log(modifiedRequest.url);

    // Pass the modified request to fetchContainer
    return fetchContainer(modifiedRequest, params.port);
  }),
]);
