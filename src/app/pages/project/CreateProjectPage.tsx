// src/app/pages/project/CreateProjectPage.tsx
"use client";

import { useActionState } from "react";
import { createProjectAction } from "./actions";

export function CreateProjectPage() {
  // I am not going to "use action state" here, just going to
  // make this an ordinary form.
  const [state, submitAction, isPending] = useActionState(
    createProjectAction,
    {}
  );

  return (
    <div className="flex flex-col items-center justify-center h-screen">
      <h1>Create Project</h1>
      <form action={submitAction} className="flex flex-col gap-2">
        <label>Name</label>
        <input type="text" name="name" required />

        <label>Description</label>
        <textarea name="description" required />

        <label>Run on Boot Commands (one per line)</label>
        <textarea
          name="runOnBoot"
          rows={4}
          placeholder="cd /workspace&#10;pnpm install&#10;pnpm run dev"
        />

        <label>Process Command</label>
        <input
          type="text"
          name="processCommand"
          placeholder="pnpm run dev --port 8910"
        />

        <label>Repository</label>
        <input type="text" name="repository" />

        <button type="submit" disabled={isPending}>
          {isPending ? "Creating..." : "Create"}
        </button>
      </form>
    </div>
  );
}
