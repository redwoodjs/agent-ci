import { Preview } from "@/app/components/Preview";

export const PreviewPage = async ({
  params,
}: {
  params: { containerId: string };
}) => {
  // TODO: The user will be able to request/ expose a port via this interface.
  return <Preview containerId={params.containerId} />;
};
