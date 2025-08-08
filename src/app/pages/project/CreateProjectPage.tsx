// src/app/pages/project/CreateProjectPage.tsx
"use client";

import { useActionState } from "react";
import { createProjectAction } from "./functions";

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

        <label className="flex items-center gap-2">
          <textarea name="runOnBoot" />
        </label>

        <label>Repository</label>
        <input type="text" name="repository" />

        <button type="submit" disabled={isPending}>
          {isPending ? "Creating..." : "Create"}
        </button>
      </form>
    </div>
  );
}
