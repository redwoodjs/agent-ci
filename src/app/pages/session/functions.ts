"use server";

import { getInstance } from "@/container";

export { newInstance, listInstances } from "@/container";

export async function getInstanceStatus(containerId: string) {
  const instance = getInstance(containerId);
  await instance.start();
  return instance;
}
