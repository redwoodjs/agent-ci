import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";
import { RequestInfo } from "rwsdk/worker";

import {
  isContainerReady,
  bootstrapContainer,
  startLongRunningProcess,
  exposePorts,
} from "./actions";

import { BootstrapLogs } from "./BootstrapLogs";
import { LongRunningProcessLogs } from "./LongRunningProcessLogs";

// This is an interruptor.

// we are making an assumption that the person will run a vite process
// that the vite process will wait for a port...
// how do I tell if the vite process has started...
export async function waitForContainer({ params }: RequestInfo) {
  const { containerId } = params;
  const status = await isContainerReady(containerId);

  console.log("=".repeat(80));
  console.log(status);
  console.log("=".repeat(80));

  if (!status.ready) {
    // deterine which part of the app to start...
    // and pass that along to this client componet
    // which then loads the correct logs.
    // NOTE: There is a race condition with this approach. We write a log file
    // and then read it later, if it's too fast then we don't
    // get the correct response, which causes the process to run multiple times.
    // I think we should also check to see which process are running
    // in the container, and then wait till it's done or something?
    if (!status.bootstrap) {
      const { processId } = await bootstrapContainer(containerId);
      return <BootstrapLogs containerId={containerId} processId={processId} />;
    }

    if (!status.longRunningProcess) {
      const { processId } = await startLongRunningProcess(containerId);
      return (
        <LongRunningProcessLogs
          containerId={containerId}
          processId={processId}
        />
      );
    }

    if (!status.portsExposed) {
      await exposePorts(containerId);
      // return (
      //   <div>
      //     Ports exposed <meta http-equiv="refresh" content="1" />
      //   </div>
      // );
    }
  }
}
