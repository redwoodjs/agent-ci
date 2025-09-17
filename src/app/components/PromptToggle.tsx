"use client";

import { useState, useEffect } from "react";
import { Prompt } from "../pages/chat/components/Prompt";

export const PromptToggle = ({ containerId }: { containerId: string }) => {
  const [isPromptVisible, setIsPromptVisible] = useState(false);

  const togglePrompt = () => {
    setIsPromptVisible((prev) => !prev);
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        togglePrompt();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="relative">
      <button
        onClick={togglePrompt}
        className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
          isPromptVisible
            ? "bg-blue-500 text-white hover:bg-blue-600"
            : "bg-gray-200 text-gray-700 hover:bg-gray-300"
        }`}
        title={`${isPromptVisible ? "Hide" : "Show"} Prompt (⌘K / Ctrl+K)`}
      >
        Prompt
      </button>

      <div
        className={`fixed top-0 right-0 w-96 h-screen bg-white border-l border-gray-300 shadow-lg z-50 transition-transform duration-200 ${
          isPromptVisible ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <Prompt containerId={containerId} autoFocus={isPromptVisible} />
      </div>
    </div>
  );
};
