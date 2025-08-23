import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";
import { RequestInfo } from "rwsdk/worker";

import { getProjectInfo } from "@/app/services/project";

import {
  bootstrapContainer,
  startLongRunningProcess,
  exposePorts,
} from "./actions";

import { LongRunningProcessLogs } from "./LongRunningProcessLogs";
import { ProcessLogs } from "../ProcessLogs";

// I'm going to refactor this so that we have distinct methods:
// 1. For copying the code over
// 2. For starting our own sandbox process
// 3. For starting the user's sandbox process

// We will not check in to see multiple statuses at once; we'll do them one at a time.
export async function isContainerReady(containerId: string) {
  // bootstrap is basically running our own sandbox process
  // but also installing the required code.
  // we need to be able to determine if it's up and running.
  // maybe we'll use something like port or port ready?

  // for now this is fine.
  // I want to start getting the claude experience working.

  let bootstrap = false;
  let longRunningProcess = false;
  let portsExposed = false;

  const project = await getProjectInfo(containerId);

  const sandbox = getSandbox(env.Sandbox, containerId);
  try {
    const { success } = await sandbox.readFile("/machinen/bootstrap.pid");
    bootstrap = success;
  } catch {
    bootstrap = false;
  }

  const processes = await sandbox.listProcesses();
  if (processes.findIndex((p) => p.command === project.processCommand) !== -1) {
    longRunningProcess = true;
  }

  // There should be a better way to check if the container is ready?
  // What do I mean by ready exactly?
  // There are different kinds of ready based on the software
  // that is running on it.
  // const sandbox = getSandbox(env.Sandbox, containerId);
  const ports = await sandbox.getExposedPorts("localhost");
  for (const p of ports) {
    if (project.exposePorts.includes(p.port)) {
      portsExposed = true;
    }
  }

  return {
    bootstrap,
    longRunningProcess,
    portsExposed,
    ready: bootstrap && longRunningProcess && portsExposed,
  };
}

const STATUS: {
  [containerId: string]: {
    bootstrapProcessId?: string;
    longRunningProcessId?: string;
  };
} = {};

export async function waitForContainer({ params }: RequestInfo) {
  const { containerId } = params;
  const status = await isContainerReady(containerId);

  console.log("=".repeat(80));
  console.log(status);
  console.log("=".repeat(80));

  if (!status.ready) {
    if (!status.bootstrap) {
      let processId = STATUS[containerId]?.bootstrapProcessId;

      if (processId) {
        return <ProcessLogs containerId={containerId} processId={processId} />;
      }

      const result = await bootstrapContainer(containerId);
      STATUS[containerId] = { bootstrapProcessId: result.processId };
      console.log("return process id", result.processId);
      return (
        <ProcessLogs containerId={containerId} processId={result.processId} />
      );
    }

    if (!status.longRunningProcess) {
      let processId = STATUS[containerId]?.longRunningProcessId;

      if (processId) {
        return (
          <LongRunningProcessLogs
            containerId={containerId}
            processId={processId}
          />
        );
      }
      const result = await startLongRunningProcess(containerId);
      STATUS[containerId] = { longRunningProcessId: result.processId };
      return (
        <ProcessLogs containerId={containerId} processId={result.processId} />
      );
    }

    if (!status.portsExposed) {
      await exposePorts(containerId);
      return (
        <div>
          Ports exposed <meta http-equiv="refresh" content="1" />
        </div>
      );
    }
  }
}
