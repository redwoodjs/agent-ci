"use server";

import { env } from "cloudflare:workers";

import {
  getInstance,
  getInstanceMetadata,
  newInstance,
  updateInstanceMetadata,
} from "@/container";

export { newInstance, listInstances } from "@/container";

export async function createNewMachine() {
  const instance = await newInstance();
  return instance;
}

export async function getInstanceStatus(containerId: string) {
  const instance = getInstance(containerId);
  await instance.startAndWaitForPorts([8911, 8910]);
  await instance.fetch(new Request("http://localhost:8910/"));
  await instance.fetch(new Request("http://localhost:8911/"));
  console.log("instance started", containerId);

  if (getInstanceMetadata(containerId).firstBoot) {
    await env.QUEUE_CONTAINER_BOOT.send({
      containerId,
      command: "echo 'hello' > hello.txt",
    });

    updateInstanceMetadata(containerId, {
      id: containerId,
      firstBoot: false,
    });
  }

  return instance;
}
