import { RequestInfo } from "rwsdk/worker";

import { ProcessLogs } from "@/app/components/ProcessLogs";
import { Heading } from "@/app/components/ui/Heading";

export const LogsPage = ({ params }: RequestInfo) => {
  const { containerId, processId } = params;

  return (
    <>
      <Heading>Logs</Heading>
      <div className="m-4">
        <ProcessLogs containerId={containerId} processId={processId} />
      </div>
    </>
  );
};
