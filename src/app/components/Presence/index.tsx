// This component will display who's online and what page they're on. If you're on the same page as them, then you will be in the same container they're on.

import { requestInfo } from "rwsdk/worker";

import { PRESENCE } from "./actions";
import { Me } from "./Me";

const COLORS = [
  "bg-blue-500",
  "bg-green-500",
  "bg-yellow-500",
  "bg-orange-500",
  "bg-purple-500",
  "bg-red-500",
  "bg-gray-500",
];

export function Presence({ containerId }: { containerId: string }) {
  const me = requestInfo.ctx?.user?.id;
  if (!me) {
    return null;
  }

  let oldContainerId;
  if (me) {
    oldContainerId = PRESENCE[me];
  }

  return (
    <ol className="flex gap-1">
      <Me
        userId={me}
        containerId={containerId}
        oldContainerId={oldContainerId}
      />
      {Object.keys(PRESENCE)
        .filter((userId) => userId !== me)
        .map((userId, index) => (
          <li
            key={userId}
            className={`rounded-full bg-gray-500 w-8 h-8 ${COLORS[index]}`}
          />
        ))}
    </ol>
  );
}
