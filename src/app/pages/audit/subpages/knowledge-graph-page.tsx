"use client";

import { useState, useEffect, useRef } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from "@/app/components/ui/card";
import { Button } from "@/app/components/ui/button";
import {
  getKnowledgeGraph,
  getKnowledgeGraphStatsAction,
} from "./actions";

// Declare mermaid for TypeScript
declare global {
  interface Window {
    mermaid?: {
      initialize: (config: { startOnLoad: boolean; theme?: string }) => void;
      contentLoaded: () => void;
      render: (
        id: string,
        definition: string
      ) => Promise<{ svg: string }>;
      parse: (definition: string) => Promise<boolean>;
    };
  }
}

function escapeMermaidId(id: string): string {
  // Mermaid IDs must be alphanumeric, so we'll use a hash or sanitize
  // Replace non-alphanumeric characters with underscores
  return id.replace(/[^a-zA-Z0-9]/g, "_");
}

function escapeMermaidLabel(label: string): string {
  // Escape special characters in labels
  return label
    .replace(/"/g, '\\"')
    .replace(/\n/g, " ")
    .substring(0, 50); // Limit length
}

function generateMermaidGraph(
  data: Array<{ id: string; title: string; parentId: string | null }>
): string {
  if (data.length === 0) {
    return "graph TD\n  Empty[No moments found]";
  }

  const lines: string[] = ["graph TD"];
  const nodeIds = new Set<string>();

  // First, collect all node IDs
  for (const item of data) {
    const nodeId = escapeMermaidId(item.id);
    nodeIds.add(nodeId);
  }

  // Create nodes
  for (const item of data) {
    const nodeId = escapeMermaidId(item.id);
    const label = escapeMermaidLabel(item.title);
    lines.push(`  ${nodeId}["${label}"]`);
  }

  // Create edges
  for (const item of data) {
    if (item.parentId) {
      const parentId = escapeMermaidId(item.parentId);
      const childId = escapeMermaidId(item.id);
      if (nodeIds.has(parentId) && nodeIds.has(childId)) {
        lines.push(`  ${parentId} --> ${childId}`);
      }
    }
  }

  return lines.join("\n");
}

export function KnowledgeGraphPage() {
  const [graphData, setGraphData] = useState<
    Array<{ id: string; title: string; parentId: string | null }>
  >([]);
  const [stats, setStats] = useState<{
    totalMoments: number;
    rootMoments: number;
    momentsWithParent: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [statsLoading, setStatsLoading] = useState(true);
  const [mermaidLoaded, setMermaidLoaded] = useState(false);
  const [showRawCode, setShowRawCode] = useState(false);
  const [mermaidCode, setMermaidCode] = useState<string>("");
  const mermaidContainerRef = useRef<HTMLDivElement>(null);
  const mermaidScriptRef = useRef<HTMLScriptElement | null>(null);

  useEffect(() => {
    // Load Mermaid.js from CDN
    if (!window.mermaid && !mermaidScriptRef.current) {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js";
      script.async = true;
      script.onload = () => {
        if (window.mermaid) {
          window.mermaid.initialize({ 
            startOnLoad: false,
            theme: 'default',
            securityLevel: 'loose',
          });
          setMermaidLoaded(true);
        }
      };
      script.onerror = () => {
        setError("Failed to load Mermaid.js");
      };
      document.head.appendChild(script);
      mermaidScriptRef.current = script;
    } else if (window.mermaid) {
      setMermaidLoaded(true);
    }
  }, []);

  useEffect(() => {
    async function fetchStats() {
      setStatsLoading(true);
      try {
        const result = await getKnowledgeGraphStatsAction();
        if (result.success && result.stats) {
          setStats(result.stats);
        } else {
          console.error("Failed to fetch stats:", result.error);
        }
      } catch (err) {
        console.error("Error fetching stats:", err);
      } finally {
        setStatsLoading(false);
      }
    }

    async function fetchGraph() {
      setLoading(true);
      setError(null);
      try {
        const result = await getKnowledgeGraph({ limit: 500 });
        if (result.success && result.data) {
          setGraphData(result.data);
        } else {
          setError(result.error || "Failed to fetch knowledge graph");
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "An unexpected error occurred"
        );
      } finally {
        setLoading(false);
      }
    }

    fetchStats();
    fetchGraph();
  }, []);

  useEffect(() => {
    if (mermaidLoaded && graphData.length > 0 && mermaidContainerRef.current) {
      const container = mermaidContainerRef.current;
      container.innerHTML = ""; // Clear previous content

      const mermaidDefinition = generateMermaidGraph(graphData);
      setMermaidCode(mermaidDefinition); // Store for debug view
      const id = `mermaid-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      if (window.mermaid) {
        // First validate the syntax
        window.mermaid
          .parse(mermaidDefinition)
          .then((isValid) => {
            if (!isValid) {
              throw new Error("Invalid Mermaid syntax");
            }
            // Then render
            return window.mermaid!.render(id, mermaidDefinition);
          })
          .then((result) => {
            if (container) {
              container.innerHTML = result.svg;
              // Make SVG responsive
              const svg = container.querySelector("svg");
              if (svg) {
                svg.style.maxWidth = "100%";
                svg.style.height = "auto";
              }
            }
          })
          .catch((err) => {
            console.error("Mermaid rendering error:", err);
            setError(
              `Failed to render graph: ${err instanceof Error ? err.message : String(err)}. The graph may be too complex.`
            );
            if (container) {
              container.innerHTML = `<div class="p-4">
                <p class="text-red-600 mb-2">Rendering failed. Showing raw Mermaid code:</p>
                <pre class="text-xs text-gray-500 p-4 overflow-auto bg-gray-50 rounded border">${mermaidDefinition}</pre>
              </div>`;
            }
          });
      }
    } else if (!loading && graphData.length === 0 && mermaidContainerRef.current) {
      mermaidContainerRef.current.innerHTML =
        '<p class="text-gray-500 text-center py-8">No graph data available</p>';
    }
  }, [mermaidLoaded, graphData, loading]);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-3xl font-bold mb-8">Knowledge Graph</h1>

      {/* Database Stats Card */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Database Statistics</CardTitle>
          <CardDescription>
            Current counts of moments in the knowledge graph database
          </CardDescription>
        </CardHeader>
        <CardContent>
          {statsLoading ? (
            <div className="text-center py-4">
              <p className="text-gray-500">Loading statistics...</p>
            </div>
          ) : stats ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                <div className="text-sm font-medium text-blue-600 mb-1">
                  Total Moments
                </div>
                <div className="text-3xl font-bold text-blue-900">
                  {stats.totalMoments}
                </div>
              </div>
              <div className="p-4 bg-green-50 rounded-lg border border-green-200">
                <div className="text-sm font-medium text-green-600 mb-1">
                  Root Moments (Subjects)
                </div>
                <div className="text-3xl font-bold text-green-900">
                  {stats.rootMoments}
                </div>
              </div>
              <div className="p-4 bg-purple-50 rounded-lg border border-purple-200">
                <div className="text-sm font-medium text-purple-600 mb-1">
                  Moments with Parent
                </div>
                <div className="text-3xl font-bold text-purple-900">
                  {stats.momentsWithParent}
                </div>
              </div>
            </div>
          ) : (
            <div className="text-center py-4">
              <p className="text-red-600">Failed to load statistics</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Moment Graph Visualization</CardTitle>
          <CardDescription>
            Visual representation of the knowledge graph showing relationships
            between moments. Root moments (subjects) are shown at the top.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading && (
            <div className="text-center py-8">
              <p className="text-gray-500">Loading graph data...</p>
            </div>
          )}

          {error && (
            <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded">
              <p className="text-red-600">{error}</p>
            </div>
          )}

          {!loading && !error && stats && stats.totalMoments === 0 && (
            <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded">
              <p className="text-yellow-800 font-medium mb-2">
                ⚠️ No moments found in database
              </p>
              <p className="text-sm text-yellow-700">
                The knowledge graph database is empty. You need to index some
                documents first. Go to the{" "}
                <a href="/audit/indexing" className="underline">
                  Indexing
                </a>{" "}
                page to process documents and create moments.
              </p>
            </div>
          )}

          {!loading && !error && (
            <>
              <div className="mb-4 flex items-center justify-between">
                <div className="text-sm text-gray-600">
                  <div>
                    Showing {graphData.length} moments (limited to 500 for
                    visualization)
                    {stats && stats.totalMoments > 500 && (
                      <span className="ml-2 text-orange-600">
                        (of {stats.totalMoments} total in database)
                      </span>
                    )}
                  </div>
                  {graphData.filter((m) => !m.parentId).length > 0 && (
                    <div className="mt-1">
                      {graphData.filter((m) => !m.parentId).length} root
                      subjects in this view
                      {stats && stats.rootMoments > 0 && (
                        <span className="ml-2">
                          ({stats.rootMoments} total in database)
                        </span>
                      )}
                    </div>
                  )}
                  {graphData.length === 0 && stats && stats.totalMoments > 0 && (
                    <div className="mt-2 text-orange-600">
                      ⚠️ Database has {stats.totalMoments} moments but none were
                      returned. Check namespace or query filters.
                    </div>
                  )}
                </div>
                {mermaidCode && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowRawCode(!showRawCode)}
                  >
                    {showRawCode ? "Hide" : "Show"} Raw Mermaid Code
                  </Button>
                )}
              </div>
              {showRawCode && mermaidCode && (
                <div className="mb-4 p-4 bg-gray-50 border rounded">
                  <p className="text-sm font-medium mb-2">Mermaid Diagram Code:</p>
                  <pre className="text-xs overflow-auto max-h-64 p-2 bg-white border rounded">
                    {mermaidCode}
                  </pre>
                </div>
              )}
              <div
                ref={mermaidContainerRef}
                className="w-full overflow-auto border rounded p-4 bg-white min-h-[400px] flex items-center justify-center"
                style={{ maxHeight: "80vh" }}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

