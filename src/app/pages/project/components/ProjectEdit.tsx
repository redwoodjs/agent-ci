"use client";

import { useState, useActionState } from "react";
import { editProjectAction } from "../actions";

interface Project {
  id: string;
  name: string;
  description: string;
  runOnBoot: string[];
  processCommand: string | null;
  repository: string | null;
  createdAt: string;
  updatedAt: string;
}

export function ProjectEdit({ project }: { project: Project }) {
  const [isEditing, setIsEditing] = useState(false);
  const [state, submitAction, isPending] = useActionState(
    editProjectAction,
    {}
  );

  const runOnBoot = project.runOnBoot.join("\n");

  if (isEditing) {
    return (
      <div className="mb-8">
        <div className="flex justify-between items-center mb-4">
          <h1 className="text-2xl font-bold">Edit Project</h1>
          <button
            onClick={() => setIsEditing(false)}
            className="px-3 py-1 text-sm bg-gray-200 hover:bg-gray-300 rounded"
          >
            Cancel
          </button>
        </div>

        <form action={submitAction} className="space-y-4">
          <input type="hidden" name="id" value={project.id} />

          <div>
            <label className="block text-sm font-medium mb-1">Name</label>
            <input
              type="text"
              name="name"
              defaultValue={project.name}
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Description
            </label>
            <textarea
              name="description"
              defaultValue={project.description}
              required
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Run on Boot
            </label>
            <textarea
              name="runOnBoot"
              defaultValue={runOnBoot}
              rows={4}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Process Command
            </label>
            <input
              type="text"
              name="processCommand"
              defaultValue={project.processCommand || ""}
              placeholder="e.g., pnpm run dev --port 8910"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Repository</label>
            <input
              type="text"
              name="repository"
              defaultValue={project.repository || ""}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={isPending}
              className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 disabled:opacity-50"
            >
              {isPending ? "Saving..." : "Save Changes"}
            </button>
            <button
              type="button"
              onClick={() => setIsEditing(false)}
              className="px-4 py-2 bg-gray-500 text-white rounded-md hover:bg-gray-600"
            >
              Cancel
            </button>
          </div>

          {state.error && (
            <div className="text-red-600 text-sm">{state.error}</div>
          )}
          {state.success && (
            <div className="text-green-600 text-sm">
              Project updated successfully!
            </div>
          )}
        </form>
      </div>
    );
  }

  return (
    <div className="mb-8">
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-2xl font-bold">Project: {project.name}</h1>
        <button
          onClick={() => setIsEditing(true)}
          className="px-3 py-1 text-sm bg-blue-500 text-white hover:bg-blue-600 rounded"
        >
          Edit
        </button>
      </div>

      <div className="space-y-2">
        <p>
          <strong>Description:</strong> {project.description}
        </p>
        <p>
          <strong>Run on Boot:</strong>
          <textarea
            readOnly={true}
            disabled={true}
            name="runOnBoot"
            defaultValue={runOnBoot}
            rows={4}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </p>
        {project.processCommand && (
          <p>
            <strong>Process Command:</strong>
            <code>{project.processCommand}</code>
          </p>
        )}
        {project.repository && (
          <p>
            <strong>Repository:</strong> {project.repository}
          </p>
        )}
      </div>
    </div>
  );
}
