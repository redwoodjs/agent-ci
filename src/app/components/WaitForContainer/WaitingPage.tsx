import { requestInfo } from "rwsdk/worker";

import { isContainerReady, startContainer } from "./functions";

export async function WaitingPage({ containerId }: { containerId: string }) {
  const ready = await isContainerReady(containerId);

  if (!ready) {
    requestInfo.cf.waitUntil(startContainer(containerId));
    return (
      <>
        <meta http-equiv="refresh" content="3" />
        <div>Waiting for container to start...</div>
      </>
    );
  }

  return <meta http-equiv="refresh" content="0" />;
}
