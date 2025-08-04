"use server";

import { getInstance } from "@/container";

export { newInstance, listInstances } from "@/container";

export async function getInstanceStatus(containerId: string) {
  const instance = getInstance(containerId);

  // this will actually start the container.
  await instance.start();
  // we start the container if it is not running.
  console.log("started yay", instance);

  return instance;
}
