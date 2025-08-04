"use client";

import { newInstance } from "./functions";

export function NewInstanceButton() {
  return (
    <button
      className="bg-blue-500 text-white p-2 rounded-md"
      onClick={async () => {
        await newInstance();
      }}
    >
      Start a new session
    </button>
  );
}
