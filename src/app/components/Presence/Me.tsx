"use client";

import { useEffect } from "react";
import { setPresence } from "./action";

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
    if (containerId !== oldContainerId) {
      setPresence(userId, containerId);
    }
  }, [oldContainerId, containerId]);

  return <li className="rounded-full bg-pink-500 w-8 h-8"></li>;
}
