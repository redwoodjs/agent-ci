import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";
import { RequestInfo } from "rwsdk/worker";

import { isContainerReady } from "./actions";
import { WaitingPage } from "./WaitingPage";

export async function waitForContainer({ params, ctx }: RequestInfo) {
  console.log("waitForContainer", params);
  const { containerId } = params;
  const sandbox = getSandbox(env.Sandbox, containerId);
  const ready = await isContainerReady(containerId);
  if (!ready) {
    return <WaitingPage containerId={containerId} />;
  }
  ctx.sandbox = sandbox;
  console.log("waitForContainer end", ctx);
}
