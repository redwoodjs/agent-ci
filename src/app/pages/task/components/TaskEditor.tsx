"use client";

import { useState } from "react";

import { Button } from "@/app/components/ui/button";

import { enhanceTask, saveTask } from "../actions";

export function TaskEditor({
  containerId,
  initialData,
  enhancedData,
}: {
  containerId: string;
  initialData: {
    title?: string;
    overview?: string;
    subtasks?: string;
  };
  enhancedData: {
    overview?: string;
    subtasks?: string;
  };
}) {
  const [title, setTitle] = useState(initialData.title ?? "");
  const [overview, setOverview] = useState(initialData.overview ?? "");
  const [subtasks, setSubtasks] = useState(initialData.subtasks ?? "");
  const [activeTab, setActiveTab] = useState<"my-notes" | "enhanced-notes">(
    "my-notes"
  );

  return (
    <div className="flex flex-row">
      <div className="flex-1">
        <div className="flex flex-1 gap-2">
          <input
            type="text"
            className="w-full text-2xl font-bold"
            value={title}
            placeholder="Issue Name"
            onChange={(e) => setTitle(e.target.value)}
          />
          <Button
            onClick={async () => {
              const result = await enhanceTask({
                containerId,
                title,
                overview,
                subtasks,
              });
            }}
            variant="outline"
            className="justify-end flex-shrink-0"
          >
            Enhance Issue
          </Button>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b">
          <button
            onClick={() => setActiveTab("my-notes")}
            className={`px-4 py-2 font-medium ${
              activeTab === "my-notes"
                ? "border-b-2 border-blue-500 text-blue-600"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            My Notes
          </button>
          <button
            onClick={() => setActiveTab("enhanced-notes")}
            className={`px-4 py-2 font-medium ${
              activeTab === "enhanced-notes"
                ? "border-b-2 border-blue-500 text-blue-600"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            Enhanced Notes
          </button>
        </div>

        {/* Tab Content */}
        {activeTab === "my-notes" && (
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-bold mb-2">Overview</h2>
              <textarea
                className="w-full border rounded p-2"
                rows={10}
                value={overview}
                placeholder="Enter your notes about this issue..."
                onChange={(e) => setOverview(e.target.value)}
              />
            </div>

            <div>
              <h2 className="text-lg font-bold mb-2">Subtasks</h2>
              <textarea
                className="w-full border rounded p-2"
                rows={10}
                value={subtasks}
                placeholder="Enter subtasks or breakdown..."
                onChange={(e) => setSubtasks(e.target.value)}
              />
            </div>

            <Button
              onClick={async () => {
                await saveTask({ containerId, title, overview, subtasks });
              }}
              variant="outline"
            >
              Save My Notes
            </Button>
          </div>
        )}

        {activeTab === "enhanced-notes" && (
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-bold mb-2">Enhanced Overview</h2>
              <div className="w-full border rounded p-2 min-h-[200px] bg-gray-50">
                {enhancedData?.overview ? (
                  <div className="whitespace-pre-wrap">
                    {enhancedData.overview}
                  </div>
                ) : (
                  <div className="text-gray-500 italic">
                    No enhanced overview available. Click "Enhance Issue" to
                    generate one.
                  </div>
                )}
              </div>
            </div>

            <div>
              <h2 className="text-lg font-bold mb-2">Enhanced Subtasks</h2>
              <div className="w-full border rounded p-2 min-h-[200px] bg-gray-50">
                {enhancedData?.subtasks ? (
                  <div className="whitespace-pre-wrap">
                    {enhancedData.subtasks}
                  </div>
                ) : (
                  <div className="text-gray-500 italic">
                    No enhanced subtasks available. Click "Enhance Issue" to
                    generate them.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
