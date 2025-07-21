"use client";

import { startNewSession } from "./functions";

export function NewSessionButton() {
  return (
    <button
      className="bg-blue-500 text-white p-2 rounded-md"
      onClick={async () => {
        // this will create a new container.
        await startNewSession();
      }}
    >
      Start a new session
    </button>
  );
}
