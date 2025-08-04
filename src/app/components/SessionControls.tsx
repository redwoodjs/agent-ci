import { Suspense } from "react";
import { getInstanceStatus } from "@/app/pages/session/functions";

interface SessionControlsProps {
  containerId: string;
}

export function Loading() {
  return (
    <div className="flex space-x-2">
      <div className="px-4 py-2 bg-gray-300 text-gray-500 rounded-lg text-sm font-medium">
        Checking...
      </div>
    </div>
  );
}

async function InstanceStatus({ containerId }: { containerId: string }) {
  const instance = await getInstanceStatus(containerId);

  return <div>InstanceStatus</div>;
  // return return (
  //   <div className="flex space-x-2">
  //     <a
  //       href={`/editor/${containerId}/`}
  //       className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-500 hover:bg-blue-600 text-white cursor-pointer">
  //       Editor
  //     </a>
  //     <a
  //       href={`/claude/${containerId}`}
  //       className="px-4 py-2 rounded-lg text-sm font-medium bg-green-500 hover:bg-green-600 text-white cursor-pointer"
  //     >
  //       Claude
  //     </a>
  //   </div>
  // );
}

export function SessionControls({ containerId }: { containerId: string }) {
  return (
    <>
      <Suspense fallback={<Loading />}>
        <InstanceStatus containerId={containerId} />
      </Suspense>
    </>
  );
}
