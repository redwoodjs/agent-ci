import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";
import { RequestInfo } from "rwsdk/worker";

import { isContainerReady } from "./functions";
import { WaitingPage } from "./WaitingPage";

export async function waitForContainer({ params, ctx }: RequestInfo) {
  const { containerId } = params;
  const sandbox = getSandbox(env.SANDBOX, containerId);
  const ready = await isContainerReady(containerId);
  if (!ready) {
    return <WaitingPage containerId={containerId} />;
  }
  ctx.sandbox = sandbox;
}
