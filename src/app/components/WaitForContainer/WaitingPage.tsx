import { isContainerReady, startContainer } from "./actions";
import { InitSandboxLogs } from "./InitSandboxLogs";

export async function WaitingPage({ containerId }: { containerId: string }) {
  const ready = await isContainerReady(containerId);

  if (!ready) {
    return (
      <>
        <div>Waiting for container to start...</div>
        <InitSandboxLogs containerId={containerId} />
      </>
    );
  }

  return <meta http-equiv="refresh" content="0" />;
}
