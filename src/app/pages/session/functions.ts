"use server";

import { startNewContainer } from "@/container";

export async function startNewSession() {
  await startNewContainer();
}
