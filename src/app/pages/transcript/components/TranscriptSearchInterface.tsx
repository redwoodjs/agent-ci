"use client";

import { useState } from "react";
import { searchTranscripts, askTranscriptQuestion, initializeTranscriptRAG, getRAGStatus } from "../actions";

interface SearchResult {
  id: string;
  score: number;
  content: string;
  metadata: Record<string, any>;
}

interface TranscriptSearchInterfaceProps {
  containerId: string;
}

export function TranscriptSearchInterface({ containerId }: TranscriptSearchInterfaceProps) {
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [aiAnswer, setAiAnswer] = useState<string>("");
  const [sources, setSources] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isAsking, setIsAsking] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [ragStatus, setRagStatus] = useState<{ status?: string; progress?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = async () => {
    if (!query.trim()) return;

    setIsSearching(true);
    setError(null);
    
    try {
      const result = await searchTranscripts(query, containerId);
      
      if (result.success) {
        setSearchResults(result.results || []);
      } else {
        setError(result.error || "Search failed");
        setSearchResults([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  const handleAskQuestion = async () => {
    if (!query.trim()) return;

    setIsAsking(true);
    setError(null);
    
    try {
      const result = await askTranscriptQuestion(query, containerId);
      
      if (result.success) {
        setAiAnswer(result.answer || "");
        setSources(result.sources || []);
      } else {
        setError(result.error || "Question failed");
        setAiAnswer("");
        setSources([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Question failed");
      setAiAnswer("");
      setSources([]);
    } finally {
      setIsAsking(false);
    }
  };

  const handleInitializeRAG = async () => {
    setIsInitializing(true);
    setError(null);
    
    try {
      const result = await initializeTranscriptRAG(containerId);
      
      if (result.success) {
        // Check status after initialization
        setTimeout(checkStatus, 2000);
      } else {
        setError(result.error || "Initialization failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Initialization failed");
    } finally {
      setIsInitializing(false);
    }
  };

  const checkStatus = async () => {
    try {
      const result = await getRAGStatus(containerId);
      if (result.success) {
        setRagStatus({
          status: result.status,
          progress: result.progress
        });
      }
    } catch (err) {
      console.error("Failed to check status:", err);
    }
  };

  const formatMetadata = (metadata: Record<string, any>) => {
    const relevant = Object.entries(metadata)
      .filter(([key]) => !key.startsWith('_'))
      .slice(0, 3);
    
    return relevant.map(([key, value]) => (
      <span key={key} className="text-xs bg-gray-100 px-2 py-1 rounded">
        {key}: {String(value)}
      </span>
    ));
  };

  return (
    <div className="space-y-6">
      <div className="bg-white border rounded-lg p-6">
        <div className="mb-4">
          <h3 className="text-lg font-semibold mb-2">AI-Powered Transcript Search</h3>
          <p className="text-sm text-gray-600 mb-4">
            Search through your meeting transcripts using natural language or ask specific questions.
          </p>
          
          {!ragStatus && (
            <button
              onClick={handleInitializeRAG}
              disabled={isInitializing}
              className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white px-4 py-2 rounded-md font-medium transition-colors mb-4"
            >
              {isInitializing ? "Initializing..." : "Initialize AI Search"}
            </button>
          )}

          {ragStatus && (
            <div className="bg-blue-50 border border-blue-200 rounded-md p-3 mb-4">
              <div className="flex items-center justify-between">
                <span className="text-blue-800 font-medium">
                  Status: {ragStatus.status || "Unknown"}
                </span>
                {ragStatus.progress !== undefined && (
                  <span className="text-blue-600">
                    Progress: {Math.round(ragStatus.progress * 100)}%
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="flex gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search transcripts or ask a question..."
              className="flex-1 px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            />
            <button
              onClick={handleSearch}
              disabled={isSearching || !ragStatus}
              className="bg-green-600 hover:bg-green-700 disabled:bg-green-400 text-white px-6 py-2 rounded-md font-medium transition-colors"
            >
              {isSearching ? "Searching..." : "Search"}
            </button>
            <button
              onClick={handleAskQuestion}
              disabled={isAsking || !ragStatus}
              className="bg-purple-600 hover:bg-purple-700 disabled:bg-purple-400 text-white px-6 py-2 rounded-md font-medium transition-colors"
            >
              {isAsking ? "Asking..." : "Ask AI"}
            </button>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md p-3 text-red-800">
              {error}
            </div>
          )}
        </div>
      </div>

      {aiAnswer && (
        <div className="bg-white border rounded-lg p-6">
          <h4 className="text-lg font-semibold mb-3 text-purple-800">AI Answer</h4>
          <div className="prose prose-sm max-w-none mb-4">
            <p className="text-gray-800 whitespace-pre-wrap">{aiAnswer}</p>
          </div>
          
          {sources.length > 0 && (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-medium text-gray-700 hover:text-gray-900">
                View Sources ({sources.length})
              </summary>
              <div className="mt-2 space-y-2 ml-4">
                {sources.map((source, index) => (
                  <div key={index} className="text-xs bg-gray-50 p-2 rounded border-l-2 border-purple-200">
                    <div className="font-medium text-gray-700 mb-1">
                      Source {index + 1}
                    </div>
                    <div className="text-gray-600">{source.content}</div>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {searchResults.length > 0 && (
        <div className="bg-white border rounded-lg p-6">
          <h4 className="text-lg font-semibold mb-4 text-green-800">
            Search Results ({searchResults.length})
          </h4>
          
          <div className="space-y-4">
            {searchResults.map((result, index) => (
              <div key={result.id || index} className="border border-gray-200 rounded-lg p-4 hover:bg-gray-50">
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="bg-green-100 text-green-800 px-2 py-1 rounded text-xs font-medium">
                      Score: {(result.score * 100).toFixed(1)}%
                    </span>
                    <div className="flex gap-1">
                      {formatMetadata(result.metadata)}
                    </div>
                  </div>
                </div>
                
                <div className="text-gray-800 text-sm leading-relaxed">
                  {result.content}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {searchResults.length === 0 && query && !isSearching && !error && (
        <div className="bg-gray-50 border rounded-lg p-6 text-center">
          <p className="text-gray-600">No results found for "{query}"</p>
          <p className="text-sm text-gray-500 mt-2">
            Try different keywords or initialize AI search first.
          </p>
        </div>
      )}
    </div>
  );
}