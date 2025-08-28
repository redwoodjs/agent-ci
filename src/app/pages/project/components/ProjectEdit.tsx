"use client";

import { useState } from "react";
import { editProjectAction } from "../actions";
import type { AppDatabase } from "@/db";

export function ProjectEdit({ project }: { project: AppDatabase["projects"] }) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runOnBoot = Array.isArray(project.runOnBoot) 
    ? project.runOnBoot.join("\n")
    : project.runOnBoot;

  const handleSubmit = async (formData: FormData) => {
    setIsSubmitting(true);
    setError(null);
    
    try {
      const result = await editProjectAction({}, formData);
      
      if (result.error) {
        setError(result.error);
      } else if (result.success) {
        window.location.href = `/projects/${project.id}`;
      }
    } catch (err) {
      setError("An unexpected error occurred");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="mb-8">
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-2xl font-bold">Edit Project</h1>
      </div>

      <form action={handleSubmit} className="space-y-4">
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

        <div>
          <label className="block text-sm font-medium mb-1">
            Expose Ports
          </label>
          <input
            type="text"
            name="exposePorts"
            defaultValue={project.exposePorts || ""}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={isSubmitting}
            className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 disabled:opacity-50"
          >
            {isSubmitting ? "Saving..." : "Save Changes"}
          </button>
          <button
            type="button"
            onClick={() => window.location.href = `/projects/${project.id}`}
            className="px-4 py-2 bg-gray-500 text-white rounded-md hover:bg-gray-600"
          >
            Cancel
          </button>
        </div>

        {error && (
          <div className="text-red-600 text-sm">{error}</div>
        )}
      </form>
    </div>
  );
}
