import { db } from "@/db";
import { AddTaskForm } from "./AddTaskForm";

export async function TaskList({ projectId }: { projectId: string }) {
  const tasks = await db
    .selectFrom("tasks")
    .where("projectId", "=", projectId)
    .selectAll()
    .orderBy("createdAt", "desc")
    .execute();

  return (
    <div className="mt-8">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-semibold">Tasks</h2>
        <AddTaskForm projectId={projectId} />
      </div>

      {tasks.length === 0 ? (
        <p className="text-gray-500">No tasks found for this project.</p>
      ) : (
        <div className="space-y-2">
          {tasks.map((task) => (
            <div
              key={task.id}
              className="border rounded-lg p-4 bg-white shadow-sm"
            >
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="font-medium">{task.name}</h3>
                  <p className="text-sm text-gray-600">
                    Container ID: {task.containerId}
                  </p>
                </div>
                <span
                  className={`px-2 py-1 rounded-full text-xs font-medium ${
                    task.status === "completed"
                      ? "bg-green-100 text-green-800"
                      : task.status === "running"
                      ? "bg-blue-100 text-blue-800"
                      : task.status === "failed"
                      ? "bg-red-100 text-red-800"
                      : "bg-gray-100 text-gray-800"
                  }`}
                >
                  {task.status}
                </span>
                <div>
                  <a href={`/chat/${task.containerId}`}>Chat</a>{" "}
                  <a href={`/preview/${task.containerId}`}>Preview</a>{" "}
                  <a href={`/logs/${task.containerId}`}>Logs</a>{" "}
                  <a href={`/editor/${task.containerId}`}>Editor</a>
                </div>
              </div>
              <p className="text-xs text-gray-400 mt-2">
                Created: {new Date(task.createdAt).toLocaleString()}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
