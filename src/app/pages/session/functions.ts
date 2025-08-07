"use server";

import {
  getInstance,
  getInstanceMetadata,
  fetchContainer,
  newInstance,
  updateInstanceMetadata,
} from "@/container";

export { newInstance, listInstances } from "@/container";

export async function createNewMachine() {
  return await newInstance();
}

export async function getInstanceStatus(containerId: string) {
  const instance = getInstance(containerId);
  await instance.startAndWaitForPorts([8911]);
  // await instance.fetch(new Request("http://localhost:8910/"));
  await instance.fetch(new Request("http://localhost:8911/"));
  console.log("instance started", containerId);

  if (getInstanceMetadata(containerId).firstBoot) {
    const response = await fetchContainer({
      containerId,
      request: new Request(`http://localhost:8911/tty/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command:
            "git clone https://github.com/redwoodjs/kitchensink . && pnpm install",
        }),
      }),
    });

    console.log("-----");
    console.log("response", await response.json());
    console.log("-----");

    updateInstanceMetadata(containerId, {
      id: containerId,
      firstBoot: false,
    });
  }

  return instance;
}
