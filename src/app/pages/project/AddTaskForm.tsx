"use client";

import { useActionState, useState } from "react";
import { createTaskAction } from "./functions";

export function AddTaskForm({ projectId }: { projectId: string }) {
  const [state, formAction] = useActionState(createTaskAction, null);
  const [isOpen, setIsOpen] = useState(false);

  const handleSuccess = () => {
    setIsOpen(false);
    window.location.reload();
  };

  if (state?.success) {
    handleSuccess();
  }

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
      >
        Add Task
      </button>
    );
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-md">
        <h3 className="text-lg font-semibold mb-4">Add New Task</h3>
        
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="projectId" value={projectId} />
          
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
              Task Name
            </label>
            <input
              type="text"
              id="name"
              name="name"
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Enter task name"
            />
          </div>
          
          <div>
            <label htmlFor="containerId" className="block text-sm font-medium text-gray-700 mb-1">
              Container ID
            </label>
            <input
              type="text"
              id="containerId"
              name="containerId"
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Enter container ID"
            />
          </div>
          
          {state?.error && (
            <div className="text-red-600 text-sm">{state.error}</div>
          )}
          
          <div className="flex justify-end space-x-3">
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="px-4 py-2 text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
            >
              Create Task
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}