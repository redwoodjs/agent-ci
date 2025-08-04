import { getInstanceStatus } from "@/app/pages/session/functions";
import { ContainerStatus } from "./ContainerStatus";

interface ContainerStatusServerProps {
  containerId: string;
}

export async function ContainerStatusServer({
  containerId,
}: ContainerStatusServerProps) {
  let initialStatus;

  try {
    initialStatus = await getInstanceStatus(containerId);
  } catch (error) {
    console.error("Failed to get initial container status:", error);
    initialStatus = {
      running: false,
      timestamp: new Date().toISOString(),
    };
  }

  return (
    <ContainerStatus containerId={containerId} initialStatus={initialStatus} />
  );
}
