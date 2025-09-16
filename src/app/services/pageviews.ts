import { db } from "@/db";

export async function recordPageview(
  request: Request,
  containerId: string,
  laneId: string
) {
  await db
    .insertInto("pageloads")
    .values({
      id: crypto.randomUUID().toLowerCase(),
      url: request.url,
      containerId: containerId,
      laneId: laneId,
      timestamp: new Date().toISOString(),
    })
    .execute();
}
