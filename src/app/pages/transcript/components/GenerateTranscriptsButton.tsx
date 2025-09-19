"use client";

import { useState } from "react";
import { generateTranscriptsFromGitHistory } from "../actions";

interface GenerateTranscriptsButtonProps {
  containerId: string;
}

export function GenerateTranscriptsButton({ containerId }: GenerateTranscriptsButtonProps) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string; error?: string } | null>(null);

  const handleGenerate = async () => {
    setIsGenerating(true);
    setResult(null);
    
    try {
      const response = await generateTranscriptsFromGitHistory(containerId);
      setResult({
        success: response.success,
        message: response.success ? response.message : (response.error || "Unknown error")
      });
      
      if (response.success) {
        // Refresh the page to show new transcripts
        window.location.reload();
      }
    } catch (error) {
      setResult({
        success: false,
        message: error instanceof Error ? error.message : "Unknown error"
      });
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="space-y-3">
      <button
        onClick={handleGenerate}
        disabled={isGenerating}
        className="bg-purple-600 hover:bg-purple-700 disabled:bg-purple-400 text-white px-4 py-2 rounded-md font-medium transition-colors"
      >
        {isGenerating ? "Generating..." : "Generate from Git History"}
      </button>
      
      {result && (
        <div className={`p-3 rounded-md text-sm ${
          result.success 
            ? "bg-green-50 text-green-800 border border-green-200" 
            : "bg-red-50 text-red-800 border border-red-200"
        }`}>
          {result.message}
        </div>
      )}
    </div>
  );
}