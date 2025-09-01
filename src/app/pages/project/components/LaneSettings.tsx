"use client";

import { useState } from "react";
import { Button } from "@/app/components/ui/button";
import { updateLane } from "@/app/services/lanes";

interface LaneSettingsProps {
  lane: {
    id: string;
    name: string;
    systemPrompt?: string;
  };
  onClose: () => void;
  onUpdate: () => void;
}

export function LaneSettings({ lane, onClose, onUpdate }: LaneSettingsProps) {
  const [name, setName] = useState(lane.name);
  const [systemPrompt, setSystemPrompt] = useState(lane.systemPrompt || "");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateLane(lane.id, name, systemPrompt);
      onUpdate();
      onClose();
    } catch (error) {
      console.error("Failed to update lane:", error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white p-6 rounded-lg shadow-lg w-96 max-w-full">
        <h2 className="text-lg font-semibold mb-4">Lane Settings</h2>
        
        <div className="mb-4">
          <label className="block text-sm font-medium mb-2">Lane Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full border border-gray-300 rounded px-3 py-2"
          />
        </div>

        <div className="mb-4">
          <label className="block text-sm font-medium mb-2">System Prompt</label>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="Enter system prompt for this lane..."
            className="w-full border border-gray-300 rounded px-3 py-2 h-32 resize-vertical"
          />
        </div>

        <div className="flex gap-2 justify-end">
          <Button
            variant="ghost"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}