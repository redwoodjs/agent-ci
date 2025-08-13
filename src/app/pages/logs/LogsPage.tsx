import { RequestInfo } from "rwsdk/worker";

import { ProcessLogs } from "@/app/components/ProcessLogs";

export const LogsPage = ({ params }: RequestInfo) => {
  const { containerId, processId } = params;

  return (
    <>
      <h1>Logs</h1>
      <ProcessLogs containerId={containerId} processId={processId} />;
    </>
  );
};
