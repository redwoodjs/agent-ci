"use client";

import { useEffect } from "react";
import { setPresence } from "./actions";

export function Me({
  userId,
  containerId,
  oldContainerId,
}: {
  userId: string;
  containerId: string;
  oldContainerId?: string;
}) {
  useEffect(() => {
    console.log("Me", userId, containerId, oldContainerId);
    if (containerId !== oldContainerId) {
      setPresence(userId, containerId);
    }
  }, []);

  return <li className="rounded-full bg-pink-500 w-8 h-8"></li>;
}
