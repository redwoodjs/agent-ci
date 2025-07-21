"use client";

export function NewSessionButton() {
  return (
    <button
      className="bg-blue-500 text-white p-2 rounded-md"
      onClick={async () => {
        await fetch(`/__machinen/process/start`);
      }}
    >
      Start a new session
    </button>
  );
}
