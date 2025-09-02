"use client";

import { useEffect, useState } from "react";
import { Button } from "@/app/components/ui/button";
import { getTaskByContainerId } from "@/app/pages/task/actions";
import { resetClaudeSession } from "@/app/components/SystemPrompt/actions";

interface SystemPromptProps {
  containerId: string;
}

interface TaskWithLane {
  id: string;
  name: string;
  projectId: string;
  containerId: string;
  status: string;
  laneId: string | null;
  laneName: string | null;
  systemPrompt: string | null;
}

export function SystemPrompt({ containerId }: SystemPromptProps) {
  const [task, setTask] = useState<TaskWithLane | null>(null);
  const [loading, setLoading] = useState(true);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadTask() {
      try {
        setLoading(true);
        setError(null);
        const taskData = await getTaskByContainerId(containerId);
        setTask(taskData as TaskWithLane);
      } catch (err) {
        console.error("Failed to load task:", err);
        setError("Failed to load task information");
      } finally {
        setLoading(false);
      }
    }

    loadTask();
  }, [containerId]);

  const handleResetSession = async () => {
    await resetClaudeSession(containerId);
    // if (!task?.laneId) {
    //   return;
    // }
    // try {
    //   setResetting(true);
    //   setError(null);
    //   // For now using a placeholder userId - in production this would come from authentication
    //   const placeholderUserId = "user-1";
    //   const result = await resetSessionWithSystemPrompt(
    //     containerId,
    //     placeholderUserId
    //   );
    //   console.log("Session reset result:", result);
    // } catch (err) {
    //   console.error("Failed to reset session:", err);
    //   setError(
    //     "Failed to reset Claude session: " +
    //       (err instanceof Error ? err.message : "Unknown error")
    //   );
    // } finally {
    //   setResetting(false);
    // }
  };

  if (loading) {
    return (
      <div className="p-4 border border-gray-200 rounded-lg bg-gray-50">
        <div className="animate-pulse">
          <div className="h-4 bg-gray-300 rounded w-1/4 mb-2"></div>
          <div className="h-20 bg-gray-300 rounded mb-3"></div>
          <div className="h-8 bg-gray-300 rounded w-32"></div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 border border-red-200 rounded-lg bg-red-50">
        <div className="text-red-600 font-medium">Error</div>
        <div className="text-red-500 text-sm">{error}</div>
      </div>
    );
  }

  if (!task) {
    return (
      <div className="p-4 border border-yellow-200 rounded-lg bg-yellow-50">
        <div className="text-yellow-800">
          Task not found for container {containerId}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 border border-gray-200 rounded-lg bg-white">
      <div className="flex justify-between items-start mb-3">
        <div>
          <h3 className="font-medium text-gray-900">System Prompt</h3>
          <div className="text-sm text-gray-500">
            Lane: {task.laneName || "No lane"} • Task: {task.name}
          </div>
        </div>
        <Button
          onClick={handleResetSession}
          disabled={resetting || !task.systemPrompt}
          size="sm"
          variant="outline"
        >
          {resetting ? "Resetting..." : "Reset Session"}
        </Button>
      </div>

      <div className="min-h-20 max-h-32 overflow-y-auto">
        {task.systemPrompt ? (
          <div className="text-sm text-gray-700 whitespace-pre-wrap p-3 bg-gray-50 rounded border">
            {task.systemPrompt}
          </div>
        ) : (
          <div className="text-sm text-gray-500 italic p-3 bg-gray-50 rounded border">
            No system prompt configured for this lane
          </div>
        )}
      </div>

      {task.systemPrompt && (
        <div className="mt-2 text-xs text-gray-400">
          Click "Reset Session" to apply this system prompt to a fresh Claude
          process
        </div>
      )}
    </div>
  );
}
