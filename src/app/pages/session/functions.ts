"use server";

import { getInstance } from "@/container";

export { newInstance, listInstances } from "@/container";

export async function getInstanceStatus(containerId: string) {
  const instance = getInstance(containerId);
  await instance.startAndWaitForPorts([8911, 8910]);
  await instance.fetch(new Request("http://localhost:8910/"));
  await instance.fetch(new Request("http://localhost:8911/"));
  console.log("instance started", containerId);
  return instance;
}
