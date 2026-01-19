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
import { Input } from "@/app/components/ui/input";
import {
  getKnowledgeGraph,
  getKnowledgeGraphStatsAction,
  getMomentGraphNamespace,
  getMomentGraphNamespacePrefix,
  getRootMomentsAction,
  getSubjectMomentsAction,
  getDescendantsForRootSlimAction,
  searchMomentsAction,
  getMomentDetailsAction,
  getMomentContextChainAction,
  getRecentDocumentAuditEventsAction,
} from "./actions";
import type { Moment } from "@/app/engine/types";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table";

// Declare mermaid for TypeScript
declare global {
  interface Window {
    mermaid?: {
      initialize: (config: { startOnLoad: boolean; theme?: string }) => void;
      contentLoaded: () => void;
      render: (id: string, definition: string) => Promise<{ svg: string }>;
      parse: (definition: string) => Promise<boolean>;
    };
  }
}

function hashToBase36(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function escapeMermaidId(id: string): string {
  const sanitized = id.replace(/[^a-zA-Z0-9]/g, "_");
  return `m_${sanitized}_${hashToBase36(id)}`;
}

function escapeMermaidLabel(label: string, maxLength: number = 150): string {
  // Clean the label - preserve newlines for HTML rendering
  let cleaned = label.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Truncate if too long (before wrapping)
  if (cleaned.length > maxLength) {
    cleaned = cleaned.substring(0, maxLength) + "...";
  }

  // Split on existing newlines first
  const paragraphs = cleaned.split("\n");
  const wrappedParagraphs: string[] = [];

  // For each paragraph, add word wrapping if needed
  for (const paragraph of paragraphs) {
    if (paragraph.length <= 40) {
      // Short enough, no wrapping needed
      wrappedParagraphs.push(paragraph);
    } else {
      // Split on spaces and add breaks every ~35 characters
      const words = paragraph.split(" ");
      const wrapped: string[] = [];
      let currentLine = "";

      for (const word of words) {
        if (
          currentLine.length + word.length + 1 > 35 &&
          currentLine.length > 0
        ) {
          wrapped.push(currentLine);
          currentLine = word;
        } else {
          currentLine = currentLine ? `${currentLine} ${word}` : word;
        }
      }
      if (currentLine) {
        wrapped.push(currentLine);
      }
      wrappedParagraphs.push(...wrapped);
    }
  }

  // Join with <br/> for HTML rendering in Mermaid
  return wrappedParagraphs.join("<br/>");
}

type GraphNode = {
  id: string;
  title: string;
  parentId?: string;
  createdAt?: string;
  timeRangeStart?: string;
  timeRangeEnd?: string;
  documentId?: string;
  importance?: number;
};

type MomentDetails = Moment & {
  provenance?: {
    streamId?: string | null;
    timeRange?: { start: string; end: string } | null;
    microPathsCount?: number;
    chunkIdsSample?: string[];
    discordMessageIdsSample?: string[];
    ingestionFilePath?: string;
  } | null;
  documentAudit?: Array<{
    id: string;
    documentId: string;
    kind: string;
    createdAt: string;
    payload: Record<string, any>;
  }> | null;
};

function readTimeRangeFromMoment(
  m: Moment
): { start: string; end: string } | null {
  const md = (m as any)?.sourceMetadata;
  const range = md?.timeRange;
  const start = typeof range?.start === "string" ? range.start : null;
  const end = typeof range?.end === "string" ? range.end : null;
  if (!start || !end) {
    return null;
  }
  return { start, end };
}

function generateMermaidGraph(data: GraphNode[]): string {
  if (data.length === 0) {
    return "graph LR\n  Empty[No moments found]";
  }

  const lines: string[] = ["graph LR"];
  const nodeIds = new Set<string>();

  // First, collect all node IDs
  for (const item of data) {
    const nodeId = escapeMermaidId(item.id);
    nodeIds.add(nodeId);
  }

  // Create nodes with HTML labels for word wrapping
  for (const item of data) {
    const nodeId = escapeMermaidId(item.id);
    const label = escapeMermaidLabel(item.title);
    // Use HTML-style labels - Mermaid will render <br/> tags as line breaks
    // Escape quotes in the label content for proper Mermaid syntax
    const escapedLabel = label.replace(/"/g, "&quot;");
    lines.push(`  ${nodeId}["${escapedLabel}"]`);
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
  const [graphData, setGraphData] = useState<GraphNode[]>([]);
  const [graphTruncated, setGraphTruncated] = useState(false);
  const [graphMaxNodes, setGraphMaxNodes] = useState(5000);
  const [graphView, setGraphView] = useState<"tree" | "chain">("tree");
  const [contextChainMomentId, setContextChainMomentId] = useState<
    string | null
  >(null);
  const [stats, setStats] = useState<{
    totalMoments: number;
    subjectMoments: number;
    unparentedMoments: number;
    momentsWithParent: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [statsLoading, setStatsLoading] = useState(true);
  const [mermaidLoaded, setMermaidLoaded] = useState(false);
  const [showRawCode, setShowRawCode] = useState(false);
  const [showRawData, setShowRawData] = useState(false);
  const [mermaidCode, setMermaidCode] = useState<string>("");
  const [selectedNamespace, setSelectedNamespace] = useState<string | null>(
    null
  );
  const [entityTab, setEntityTab] = useState<"subjects" | "moments">(
    "subjects"
  );
  const [prefix, setPrefix] = useState<string | null>(null);
  const [prefixOverride, setPrefixOverride] = useState<string>("");
  const [effectiveNamespace, setEffectiveNamespace] = useState<string | null>(
    null
  );
  const [selectedRootId, setSelectedRootId] = useState<string | null>(null);
  const [rootMoments, setRootMoments] = useState<
    Array<{
      id: string;
      title: string;
      parentId: string | null;
      createdAt: string;
      descendantCount: number | null;
      subjectKind?: string | null;
    }>
  >([]);
  const [rootMomentsLoading, setRootMomentsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [hideSingletons, setHideSingletons] = useState(false);
  const [rootSort, setRootSort] = useState<"descendants" | "createdAt">(
    "descendants"
  );
  const [semanticQuery, setSemanticQuery] = useState<string>("");
  const [semanticResults, setSemanticResults] = useState<
    Array<{
      matchId: string;
      score: number;
      matchTitle: string;
      matchSummary: string;
      matchDocumentId: string;
      rootId: string;
      rootTitle: string;
    }>
  >([]);
  const [semanticLoading, setSemanticLoading] = useState(false);
  const [semanticError, setSemanticError] = useState<string | null>(null);
  const [pendingHighlightMomentId, setPendingHighlightMomentId] = useState<
    string | null
  >(null);

  const [recentAuditDocs, setRecentAuditDocs] = useState<any[] | null>(null);
  const [recentAuditDocsLoading, setRecentAuditDocsLoading] = useState(false);
  const [recentAuditDocsError, setRecentAuditDocsError] = useState<
    string | null
  >(null);
  const mermaidContainerRef = useRef<HTMLDivElement>(null);
  const mermaidScriptRef = useRef<HTMLScriptElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const svgContainerRef = useRef<HTMLDivElement>(null);
  const [selectedMomentId, setSelectedMomentId] = useState<string | null>(null);
  const nodeClickCleanupRef = useRef<null | (() => void)>(null);

  const [selectedMomentDetails, setSelectedMomentDetails] =
    useState<MomentDetails | null>(null);
  const [selectedMomentDetailsLoading, setSelectedMomentDetailsLoading] =
    useState(false);
  const [selectedMomentDetailsError, setSelectedMomentDetailsError] = useState<
    string | null
  >(null);
  const selectedMomentTimeRange = selectedMomentDetails
    ? readTimeRangeFromMoment(selectedMomentDetails)
    : null;

  useEffect(() => {
    // Load Mermaid.js from CDN
    if (!window.mermaid && !mermaidScriptRef.current) {
      const script = document.createElement("script");
      script.src =
        "https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js";
      script.async = true;
      script.onload = () => {
        if (window.mermaid) {
          window.mermaid.initialize({
            startOnLoad: false,
            theme: "default",
            flowchart: {
              htmlLabels: true,
              curve: "basis",
              padding: 8,
            },
            themeVariables: {
              fontSize: "12px",
              fontFamily: "inherit",
              primaryColor: "#e0e0e0",
              primaryTextColor: "#000",
              primaryBorderColor: "#999",
              lineColor: "#999",
              secondaryColor: "#f4f4f4",
              tertiaryColor: "#fff",
            },
          } as any);
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

  // Initialize selectedRootId from URL on mount
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const tabFromUrl = urlParams.get("tab");
    if (tabFromUrl === "moments") {
      setEntityTab("moments");
    }
    const rootIdFromUrl = urlParams.get("rootId");
    if (rootIdFromUrl) {
      setSelectedRootId(rootIdFromUrl);
    }
    const viewFromUrl = urlParams.get("view");
    if (viewFromUrl === "chain") {
      setGraphView("chain");
    }
    const highlightMomentIdFromUrl = urlParams.get("highlightMomentId");
    if (
      typeof highlightMomentIdFromUrl === "string" &&
      highlightMomentIdFromUrl.trim().length > 0
    ) {
      setPendingHighlightMomentId(highlightMomentIdFromUrl.trim());
      if (viewFromUrl === "chain") {
        setContextChainMomentId(highlightMomentIdFromUrl.trim());
      }
    }
    const namespaceFromUrl = urlParams.get("namespace");
    if (
      typeof namespaceFromUrl === "string" &&
      namespaceFromUrl.trim().length > 0
    ) {
      setSelectedNamespace(namespaceFromUrl.trim());
    }
    const prefixFromUrl =
      urlParams.get("prefix") ?? urlParams.get("namespacePrefix");
    if (typeof prefixFromUrl === "string" && prefixFromUrl.trim().length > 0) {
      setPrefixOverride(prefixFromUrl.trim());
    }
  }, []);

  useEffect(() => {
    setSelectedRootId(null);
    setSelectedMomentId(null);
    setPendingHighlightMomentId(null);
    setContextChainMomentId(null);
    setSearchQuery("");
    setSemanticQuery("");
    setSemanticResults([]);
    setSemanticError(null);
    setGraphData([]);
    setGraphTruncated(false);
  }, [entityTab]);

  // Update URL when selectedRootId changes (using pushState for shareable links)
  useEffect(() => {
    const url = new URL(window.location.href);
    if (entityTab === "moments") {
      url.searchParams.set("tab", "moments");
    } else {
      url.searchParams.delete("tab");
    }
    if (selectedRootId) {
      url.searchParams.set("rootId", selectedRootId);
    } else {
      url.searchParams.delete("rootId");
    }
    if (graphView === "chain") {
      url.searchParams.set("view", "chain");
    } else {
      url.searchParams.delete("view");
    }
    if (typeof selectedNamespace === "string" && selectedNamespace.length > 0) {
      url.searchParams.set("namespace", selectedNamespace);
    } else {
      url.searchParams.delete("namespace");
    }
    if (prefixOverride.trim().length > 0) {
      url.searchParams.set("prefix", prefixOverride.trim());
    } else {
      url.searchParams.delete("prefix");
    }
    const highlightMomentId =
      graphView === "chain"
        ? contextChainMomentId
        : selectedMomentId ?? pendingHighlightMomentId;
    if (typeof highlightMomentId === "string" && highlightMomentId.length > 0) {
      url.searchParams.set("highlightMomentId", highlightMomentId);
    } else {
      url.searchParams.delete("highlightMomentId");
    }
    window.history.pushState({}, "", url.toString());
  }, [
    entityTab,
    selectedRootId,
    graphView,
    contextChainMomentId,
    selectedMomentId,
    pendingHighlightMomentId,
    prefixOverride,
    selectedNamespace,
  ]);

  useEffect(() => {
    async function fetchPrefix() {
      try {
        const result = await getMomentGraphNamespacePrefix();
        if (result.success) {
          setPrefix(result.prefix ?? null);
        }
      } catch (err) {
        console.error("Error fetching prefix:", err);
      }
    }

    fetchPrefix();
  }, []);

  useEffect(() => {
    async function fetchNamespace() {
      if (
        typeof selectedNamespace === "string" &&
        selectedNamespace.length > 0
      ) {
        return;
      }
      try {
        const result = await getMomentGraphNamespace();
        if (result.success) {
          if (
            typeof result.namespace === "string" &&
            result.namespace.length > 0
          ) {
            setSelectedNamespace(result.namespace);
          }
        }
      } catch (err) {
        console.error("Error fetching namespace:", err);
      }
    }

    fetchNamespace();
  }, [selectedNamespace]);

  useEffect(() => {
    async function fetchStats() {
      setStatsLoading(true);
      try {
        const result = await getKnowledgeGraphStatsAction({
          momentGraphNamespace: selectedNamespace,
          momentGraphNamespacePrefix:
            prefixOverride.trim().length > 0 ? prefixOverride.trim() : null,
        });
        if (result.success && result.stats) {
          setStats(result.stats);
          if (result.effectiveNamespace !== undefined) {
            setEffectiveNamespace(result.effectiveNamespace);
          }
        } else {
          console.error("Failed to fetch stats:", result.error);
        }
      } catch (err) {
        console.error("Error fetching stats:", err);
      } finally {
        setStatsLoading(false);
      }
    }

    fetchStats();
  }, [selectedNamespace, prefixOverride]);

  useEffect(() => {
    async function fetchRootMoments() {
      setRootMomentsLoading(true);
      try {
        const listFn =
          entityTab === "moments"
            ? getRootMomentsAction
            : getSubjectMomentsAction;
        const result = await listFn({
          limit: 1000,
          momentGraphNamespace: selectedNamespace,
          momentGraphNamespacePrefix:
            prefixOverride.trim().length > 0 ? prefixOverride.trim() : null,
        });
        if (result.success && result.data) {
          setRootMoments(result.data);
          if (result.effectiveNamespace !== undefined) {
            setEffectiveNamespace(result.effectiveNamespace);
          }
        } else {
          console.error("Failed to fetch list:", result.error);
        }
      } catch (err) {
        console.error("Error fetching list:", err);
      } finally {
        setRootMomentsLoading(false);
      }
    }

    if (!selectedRootId) {
      fetchRootMoments();
    }
  }, [selectedNamespace, selectedRootId, prefixOverride, entityTab]);

  useEffect(() => {}, []);

  useEffect(() => {
    async function fetchGraph() {
      if (graphView === "chain") {
        return;
      }
      if (!selectedRootId) {
        setGraphData([]);
        setGraphTruncated(false);
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const result = await getDescendantsForRootSlimAction(selectedRootId, {
          momentGraphNamespace: selectedNamespace,
          momentGraphNamespacePrefix:
            prefixOverride.trim().length > 0 ? prefixOverride.trim() : null,
          maxNodes: graphMaxNodes,
        });
        if (result.success && result.data) {
          setGraphData(result.data);
          setGraphTruncated(Boolean((result as any).truncated));
          if (result.effectiveNamespace !== undefined) {
            setEffectiveNamespace(result.effectiveNamespace);
          }
        } else {
          setError(result.error || "Failed to fetch descendants");
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "An unexpected error occurred"
        );
      } finally {
        setLoading(false);
      }
    }

    fetchGraph();
  }, [
    graphView,
    selectedRootId,
    selectedNamespace,
    prefixOverride,
    graphMaxNodes,
  ]);

  useEffect(() => {
    async function fetchContextChain() {
      if (graphView !== "chain") {
        return;
      }
      if (!contextChainMomentId) {
        setGraphData([]);
        setGraphTruncated(false);
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const res = await getMomentContextChainAction(contextChainMomentId, {
          momentGraphNamespace: selectedNamespace,
          momentGraphNamespacePrefix:
            prefixOverride.trim().length > 0 ? prefixOverride.trim() : null,
          maxDownHops: 40,
        });
        if (res.success) {
          setGraphData(res.data);
          setGraphTruncated(false);
        } else {
          setError(res.error || "Failed to fetch context chain");
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "An unexpected error occurred"
        );
      } finally {
        setLoading(false);
      }
    }

    fetchContextChain();
  }, [graphView, contextChainMomentId, selectedNamespace, prefixOverride]);

  useEffect(() => {
    async function fetchSelectedMomentDetails() {
      if (!selectedMomentId) {
        setSelectedMomentDetails(null);
        setSelectedMomentDetailsError(null);
        return;
      }
      setSelectedMomentDetailsLoading(true);
      setSelectedMomentDetailsError(null);
      try {
        const res = await getMomentDetailsAction(selectedMomentId, {
          momentGraphNamespace: selectedNamespace,
          momentGraphNamespacePrefix:
            prefixOverride.trim().length > 0 ? prefixOverride.trim() : null,
          includeProvenance: true,
          provenanceMaxChunkIds: 40,
        });
        if (res.success) {
          setSelectedMomentDetails(res.data ?? null);
        } else {
          setSelectedMomentDetails(null);
          setSelectedMomentDetailsError(res.error || "Failed to fetch moment");
        }
      } catch (err) {
        setSelectedMomentDetails(null);
        setSelectedMomentDetailsError(
          err instanceof Error ? err.message : "Failed to fetch moment"
        );
      } finally {
        setSelectedMomentDetailsLoading(false);
      }
    }
    fetchSelectedMomentDetails();
  }, [selectedMomentId, selectedNamespace, prefixOverride]);

  useEffect(() => {
    async function fetchRecentFailures() {
      setRecentAuditDocsLoading(true);
      setRecentAuditDocsError(null);
      try {
        const res = await getRecentDocumentAuditEventsAction({
          momentGraphNamespace: selectedNamespace,
          momentGraphNamespacePrefix:
            prefixOverride.trim().length > 0 ? prefixOverride.trim() : null,
          kindPrefixes: ["indexing:", "synthesis:"],
          limitDocuments: 20,
          limitEvents: 200,
        });
        if (res.success) {
          setRecentAuditDocs(res.docs ?? []);
        } else {
          setRecentAuditDocs(null);
          setRecentAuditDocsError(
            res.error || "Failed to fetch recent failures"
          );
        }
      } catch (err) {
        setRecentAuditDocs(null);
        setRecentAuditDocsError(
          err instanceof Error ? err.message : "Failed to fetch recent failures"
        );
      } finally {
        setRecentAuditDocsLoading(false);
      }
    }
    fetchRecentFailures();
  }, [selectedNamespace, prefixOverride]);

  useEffect(() => {
    if (loading) {
      return;
    }
    if (!pendingHighlightMomentId) {
      return;
    }
    const match = graphData.find((m) => m.id === pendingHighlightMomentId);
    if (match) {
      setSelectedMomentId(pendingHighlightMomentId);
    }
    setPendingHighlightMomentId(null);
  }, [selectedRootId, loading, graphData, pendingHighlightMomentId]);

  useEffect(() => {
    if (mermaidLoaded && graphData.length > 0 && mermaidContainerRef.current) {
      const container = mermaidContainerRef.current;
      container.innerHTML = ""; // Clear previous content
      if (nodeClickCleanupRef.current) {
        nodeClickCleanupRef.current();
        nodeClickCleanupRef.current = null;
      }

      const mermaidDefinition = generateMermaidGraph(graphData);
      setMermaidCode(mermaidDefinition); // Store for debug view
      const id = `mermaid-${Date.now()}-${Math.random()
        .toString(36)
        .substr(2, 9)}`;

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
              // Make SVG responsive and prepare for zoom/pan
              const svg = container.querySelector("svg");
              if (svg) {
                svg.style.maxWidth = "none";
                svg.style.height = "auto";
                // Reset zoom/pan when new graph is rendered
                setZoom(1);
                setPan({ x: 0, y: 0 });

                const cleanups: Array<() => void> = [];
                for (const moment of graphData) {
                  const escapedId = escapeMermaidId(moment.id);
                  const nodes = svg.querySelectorAll(
                    `g[id*="${escapedId}"]`
                  ) as NodeListOf<SVGGElement>;
                  for (const node of nodes) {
                    node.style.cursor = "pointer";
                    const handler = (e: Event) => {
                      e.stopPropagation();
                      setGraphView("chain");
                      setContextChainMomentId(moment.id);
                      setPendingHighlightMomentId(moment.id);
                    };
                    node.addEventListener("click", handler);
                    cleanups.push(() =>
                      node.removeEventListener("click", handler)
                    );
                  }
                }
                nodeClickCleanupRef.current = () => {
                  for (const cleanup of cleanups) {
                    cleanup();
                  }
                };
              }
            }
          })
          .catch((err) => {
            console.error("Mermaid rendering error:", err);
            setError(
              `Failed to render graph: ${
                err instanceof Error ? err.message : String(err)
              }. The graph may be too complex.`
            );
            if (container) {
              container.innerHTML = `<div class="p-4">
                <p class="text-red-600 mb-2">Rendering failed. Showing raw Mermaid code:</p>
                <pre class="text-xs text-gray-500 p-4 overflow-auto bg-gray-50 rounded border">${mermaidDefinition}</pre>
              </div>`;
            }
          });
      }
    } else if (
      !loading &&
      graphData.length === 0 &&
      mermaidContainerRef.current
    ) {
      mermaidContainerRef.current.innerHTML =
        '<p class="text-gray-500 text-center py-8">No graph data available</p>';
    }

    return () => {
      if (nodeClickCleanupRef.current) {
        nodeClickCleanupRef.current();
        nodeClickCleanupRef.current = null;
      }
    };
  }, [mermaidLoaded, graphData, loading]);

  useEffect(() => {
    if (!selectedMomentId) {
      return;
    }
    const stillPresent = graphData.some((m) => m.id === selectedMomentId);
    if (!stillPresent) {
      setSelectedMomentId(null);
    }
  }, [graphData, selectedMomentId]);

  const namespaceOptions = [
    { value: null, label: "Default (all namespaces)" },
    { value: "redwood:machinen", label: "redwood:machinen" },
    { value: "redwood:rwsdk", label: "redwood:rwsdk" },
    { value: "redwood:internal", label: "redwood:internal" },
  ];

  const filteredRootMoments = rootMoments
    .filter((root) => {
      if (
        hideSingletons &&
        typeof root.descendantCount === "number" &&
        root.descendantCount === 0
      ) {
        return false;
      }
      if (!searchQuery.trim()) {
        return true;
      }
      const query = searchQuery.toLowerCase();
      return (
        root.title.toLowerCase().includes(query) ||
        root.id.toLowerCase().includes(query)
      );
    })
    .slice()
    .sort((a, b) => {
      if (rootSort === "descendants") {
        const aCount =
          typeof a.descendantCount === "number" ? a.descendantCount : -1;
        const bCount =
          typeof b.descendantCount === "number" ? b.descendantCount : -1;
        if (aCount !== bCount) {
          return bCount - aCount;
        }
      }
      if (a.createdAt !== b.createdAt) {
        return a.createdAt.localeCompare(b.createdAt);
      }
      return a.id.localeCompare(b.id);
    });

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-3xl font-bold mb-8">Knowledge Graph</h1>

      {/* System Context Card */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>System Context</CardTitle>
          <CardDescription>
            Namespace configuration and active prefix
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Namespace Prefix (from environment)
              </label>
              <div className="p-3 bg-gray-50 rounded border font-mono text-sm">
                {prefix ? (
                  <span className="text-blue-600">{prefix}</span>
                ) : (
                  <span className="text-gray-400">Not set</span>
                )}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Namespace Prefix Override (optional)
              </label>
              <Input
                type="text"
                placeholder="demo-2026-01-06"
                value={prefixOverride}
                onChange={(e) => setPrefixOverride(e.target.value)}
                className="w-full font-mono"
              />
              <div className="text-xs text-gray-500 mt-1">
                When set, this prefix is used instead of the environment prefix
                for graph queries.
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Select Namespace
              </label>
              <select
                value={selectedNamespace || ""}
                onChange={(e) => setSelectedNamespace(e.target.value || null)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
              >
                {namespaceOptions.map((option) => (
                  <option
                    key={option.value || "null"}
                    value={option.value || ""}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            {effectiveNamespace && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Effective Namespace (being queried)
                </label>
                <div className="p-3 bg-blue-50 rounded border font-mono text-sm text-blue-900">
                  {effectiveNamespace}
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <details className="mb-6">
        <Card>
          <CardHeader>
            <CardTitle>Recent failures</CardTitle>
            <CardDescription>
              Documents with recent indexing or synthesis audit events
            </CardDescription>
          </CardHeader>
        </Card>
        <div className="mt-2">
          <Card>
            <CardContent>
              {recentAuditDocsLoading && (
                <div className="text-sm text-gray-600">Loading…</div>
              )}
              {recentAuditDocsError && (
                <div className="text-sm text-red-600">
                  {recentAuditDocsError}
                </div>
              )}
              {!recentAuditDocsLoading &&
                !recentAuditDocsError &&
                (!Array.isArray(recentAuditDocs) ||
                  recentAuditDocs.length === 0) && (
                  <div className="text-sm text-gray-600">
                    No recent audit events found.
                  </div>
                )}
              {Array.isArray(recentAuditDocs) && recentAuditDocs.length > 0 && (
                <div className="space-y-2">
                  {recentAuditDocs.map((d) => {
                    const docId =
                      typeof d?.documentId === "string" ? d.documentId : "";
                    const kind =
                      typeof d?.kind === "string" ? d.kind : "unknown";
                    const createdAt =
                      typeof d?.createdAt === "string" ? d.createdAt : "";
                    const message =
                      typeof d?.payload?.message === "string"
                        ? d.payload.message
                        : null;
                    const ingestionPath =
                      docId.length > 0
                        ? `/audit/ingestion/file/${encodeURIComponent(docId)}`
                        : null;
                    return (
                      <div
                        key={String(d?.id ?? docId)}
                        className="border rounded p-2"
                      >
                        <div className="text-xs text-gray-600">
                          <span className="font-mono">{kind}</span>{" "}
                          <span className="text-gray-400">{createdAt}</span>
                        </div>
                        {docId && (
                          <div className="text-xs mt-1">
                            Document:{" "}
                            <span className="font-mono break-all">{docId}</span>
                          </div>
                        )}
                        {message && (
                          <div className="text-xs text-gray-700 mt-1">
                            {message}
                          </div>
                        )}
                        {ingestionPath && (
                          <div className="text-xs mt-1">
                            <a
                              href={ingestionPath}
                              className="text-blue-600 hover:underline"
                              target="_blank"
                              rel="noreferrer"
                            >
                              Open ingestion file
                            </a>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </details>

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
                  Subject Moments
                </div>
                <div className="text-3xl font-bold text-green-900">
                  {stats.subjectMoments}
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
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>
                {selectedRootId
                  ? entityTab === "moments"
                    ? "Moment Tree Visualization"
                    : "Subject Tree Visualization"
                  : entityTab === "moments"
                  ? "Moments (Select to Drill Down)"
                  : "Subjects (Select to Drill Down)"}
              </CardTitle>
              <CardDescription>
                {selectedRootId
                  ? "Visual representation of a specific subject's moment tree"
                  : entityTab === "moments"
                  ? "Select a moment below to view its tree structure"
                  : "Select a subject below to view its complete tree structure"}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center rounded border overflow-hidden">
                <button
                  type="button"
                  className={
                    entityTab === "subjects"
                      ? "px-3 py-1 text-sm bg-blue-50 text-blue-700"
                      : "px-3 py-1 text-sm text-blue-600 hover:bg-gray-50"
                  }
                  onClick={() => setEntityTab("subjects")}
                >
                  Subjects
                </button>
                <button
                  type="button"
                  className={
                    entityTab === "moments"
                      ? "px-3 py-1 text-sm bg-blue-50 text-blue-700"
                      : "px-3 py-1 text-sm text-blue-600 hover:bg-gray-50"
                  }
                  onClick={() => setEntityTab("moments")}
                >
                  Moments
                </button>
              </div>
              {selectedRootId && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSelectedRootId(null);
                    setSearchQuery("");
                  }}
                >
                  ← Back to {entityTab === "moments" ? "Moments" : "Subjects"}
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>


          {rootMomentsLoading && !selectedRootId && (
            <div className="text-center py-8">
              <p className="text-gray-500">
                Loading {entityTab === "moments" ? "moments" : "subjects"}...
              </p>
            </div>
          )}

          {error && (
            <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded">
              <p className="text-red-600">{error}</p>
            </div>
          )}

          {!loading &&
            !rootMomentsLoading &&
            !error &&
            stats &&
            stats.totalMoments === 0 && (
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

          {!selectedRootId && !rootMomentsLoading && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="border rounded p-4">
                  <div className="text-sm font-medium text-gray-900 mb-2">
                    List Controls
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Sort (all)
                      </label>
                      <select
                        value={rootSort}
                        onChange={(e) =>
                          setRootSort(
                            e.target.value === "createdAt"
                              ? "createdAt"
                              : "descendants"
                          )
                        }
                        className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                      >
                        <option value="descendants">Descendant count</option>
                        <option value="createdAt">Created time</option>
                      </select>
                    </div>
                    <div className="md:col-span-2">
                      <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                        <input
                          type="checkbox"
                          checked={hideSingletons}
                          onChange={(e) => setHideSingletons(e.target.checked)}
                        />
                        Hide singletons (all)
                      </label>
                    </div>
                  </div>
                </div>

                <div className="border rounded p-4">
                  <div className="text-sm font-medium text-gray-900 mb-2">
                    Semantic Search (jump to tree)
                  </div>
                  <div className="flex gap-2">
                    <Input
                      type="text"
                      placeholder="Search by meaning (example: prefetch navigation GET)"
                      value={semanticQuery}
                      onChange={(e) => setSemanticQuery(e.target.value)}
                      className="w-full"
                    />
                    <Button
                      variant="outline"
                      onClick={async () => {
                        setSemanticError(null);
                        setSemanticResults([]);
                        const q = semanticQuery.trim();
                        if (!q) {
                          return;
                        }
                        setSemanticLoading(true);
                        try {
                          const res = await searchMomentsAction({
                            query: q,
                            limit: 10,
                            momentGraphNamespace: selectedNamespace,
                            momentGraphNamespacePrefix:
                              prefixOverride.trim().length > 0
                                ? prefixOverride.trim()
                                : null,
                          });
                          if (res.success && res.results) {
                            setSemanticResults(res.results);
                          } else {
                            setSemanticError(res.error || "Search failed");
                          }
                        } catch (err) {
                          setSemanticError(
                            err instanceof Error ? err.message : "Search failed"
                          );
                        } finally {
                          setSemanticLoading(false);
                        }
                      }}
                      disabled={semanticLoading}
                    >
                      {semanticLoading ? "Searching..." : "Search"}
                    </Button>
                  </div>
                  {semanticError && (
                    <div className="text-sm text-red-600 mt-2">
                      {semanticError}
                    </div>
                  )}
                  {semanticResults.length > 0 && (
                    <div className="mt-3 space-y-2 max-h-64 overflow-auto">
                      {semanticResults.map((r) => (
                        <button
                          key={`${r.matchId}-${r.rootId}`}
                          onClick={() => {
                            setSelectedRootId(r.rootId);
                            setPendingHighlightMomentId(r.matchId);
                          }}
                          className="w-full text-left border rounded p-2 hover:bg-blue-50 hover:border-blue-300 transition-colors"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-sm font-medium text-gray-900">
                              {r.matchTitle || "Untitled"}
                            </div>
                            <div className="text-xs font-mono text-gray-600">
                              {r.score.toFixed(3)}
                            </div>
                          </div>
                          <div className="text-xs text-gray-600 mt-1 line-clamp-2">
                            {r.matchSummary}
                          </div>
                          <div className="text-xs text-gray-500 mt-1">
                            Root: <span className="font-mono">{r.rootId}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {rootMoments.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  No items found. Try selecting a different namespace.
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-sm text-gray-600">
                      Found {filteredRootMoments.length}{" "}
                      {entityTab === "moments" ? "moment" : "subject"}
                      {filteredRootMoments.length !== 1 ? "s" : ""}. Click on
                      any item to view its tree.
                    </p>
                  </div>
                  <div className="mb-4">
                    <Input
                      type="text"
                      placeholder={
                        entityTab === "moments"
                          ? "Search moments by title or ID..."
                          : "Search subjects by title or ID..."
                      }
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full"
                    />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    {filteredRootMoments.map((root) => {
                      const date = new Date(root.createdAt);
                      const formattedDate = date.toLocaleDateString("en-US", {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      });
                      return (
                        <button
                          key={root.id}
                          onClick={() => setSelectedRootId(root.id)}
                          className="p-4 text-left border rounded-lg hover:bg-blue-50 hover:border-blue-300 transition-colors"
                        >
                          <div className="font-medium text-gray-900 mb-2">
                            {root.title}
                          </div>
                          <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
                            <span>{formattedDate}</span>
                            <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded">
                              {typeof root.descendantCount === "number"
                                ? `${root.descendantCount} moment${
                                    root.descendantCount !== 1 ? "s" : ""
                                  }`
                                : "descendants=N/A"}
                            </span>
                          </div>
                          <div className="text-xs text-gray-400 font-mono mt-1">
                            {root.id.substring(0, 8)}...
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  {searchQuery.trim() && filteredRootMoments.length === 0 && (
                    <div className="text-center py-8 text-gray-500">
                      No subjects found matching "{searchQuery}"
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {selectedRootId && !loading && !error && (
            <>
              <div className="mb-4 flex items-center justify-between">
                <div className="text-sm text-gray-600">
                  <div>
                    Showing {graphData.length} moment
                    {graphData.length !== 1 ? "s" : ""} in this subject tree
                  </div>
                  {graphTruncated && (
                    <div className="mt-2 text-orange-600">
                      Tree truncated at {graphMaxNodes} nodes (RPC payload cap).
                    </div>
                  )}
                  {graphData.length === 0 && (
                    <div className="mt-2 text-orange-600">
                      ⚠️ No descendants found for this subject.
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowRawData(!showRawData)}
                  >
                    {showRawData ? "Hide" : "Show"} Raw Data
                  </Button>
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
              </div>
              {showRawData && (
                <div className="mb-4 p-4 bg-gray-50 border rounded">
                  <p className="text-sm font-medium mb-2">
                    Raw Graph Data (JSON):
                  </p>
                  <pre className="text-xs overflow-auto max-h-96 p-2 bg-white border rounded">
                    {JSON.stringify(graphData, null, 2)}
                  </pre>
                </div>
              )}
              {showRawCode && mermaidCode && (
                <div className="mb-4 p-4 bg-gray-50 border rounded">
                  <p className="text-sm font-medium mb-2">
                    Mermaid Diagram Code:
                  </p>
                  <pre className="text-xs overflow-auto max-h-64 p-2 bg-white border rounded">
                    {mermaidCode}
                  </pre>
                </div>
              )}
              <div className="mb-4">
                <div className="flex items-center justify-end gap-2 mb-2">
                  <div className="flex items-center gap-2 mr-auto">
                    <span className="text-sm text-gray-600">Max nodes</span>
                    <Input
                      type="number"
                      value={String(graphMaxNodes)}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (!Number.isFinite(n)) {
                          return;
                        }
                        setGraphMaxNodes(
                          Math.max(100, Math.min(20000, Math.floor(n)))
                        );
                      }}
                      className="w-[140px] font-mono"
                    />
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setZoom(Math.max(0.5, zoom - 0.25))}
                    disabled={zoom <= 0.5}
                  >
                    Zoom Out
                  </Button>
                  <span className="text-sm text-gray-600 min-w-[80px] text-center">
                    {Math.round(zoom * 100)}%
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setZoom(Math.min(3, zoom + 0.25))}
                    disabled={zoom >= 3}
                  >
                    Zoom In
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setZoom(1);
                      setPan({ x: 0, y: 0 });
                    }}
                  >
                    Reset
                  </Button>
                </div>
                <div className="flex flex-col lg:flex-row gap-4">
                  <div
                    ref={svgContainerRef}
                    className="relative w-full border rounded bg-white overflow-auto lg:flex-1"
                    style={{ maxHeight: "80vh", minHeight: "400px" }}
                    onMouseDown={(e) => {
                      if (e.button === 0 && e.currentTarget === e.target) {
                        setIsPanning(true);
                        setPanStart({
                          x: e.clientX - pan.x,
                          y: e.clientY - pan.y,
                        });
                      }
                    }}
                    onMouseMove={(e) => {
                      if (isPanning) {
                        setPan({
                          x: e.clientX - panStart.x,
                          y: e.clientY - panStart.y,
                        });
                      }
                    }}
                    onMouseUp={() => setIsPanning(false)}
                    onMouseLeave={() => setIsPanning(false)}
                    onWheel={(e) => {
                      e.preventDefault();
                      const delta = e.deltaY > 0 ? -0.1 : 0.1;
                      setZoom(Math.max(0.5, Math.min(3, zoom + delta)));
                    }}
                  >
                    <div
                      ref={mermaidContainerRef}
                      className="flex items-center justify-center p-4"
                      style={{
                        transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                        transformOrigin: "center center",
                        transition: isPanning
                          ? "none"
                          : "transform 0.1s ease-out",
                        minWidth: "100%",
                        minHeight: "100%",
                      }}
                    />
                  </div>

                  <div className="w-full lg:w-[420px] border rounded bg-white">
                    <div className="p-4 border-b">
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-medium text-gray-900">
                          Moment Details
                        </div>
                        {selectedMomentId && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setSelectedMomentId(null)}
                          >
                            Clear
                          </Button>
                        )}
                      </div>
                      <div className="text-xs text-gray-500 mt-1">
                        Click a node (or a row in the table) to inspect linkage
                        decisions
                      </div>
                    </div>

                    <div className="p-4 space-y-4 max-h-[80vh] overflow-auto">
                      {selectedMomentDetailsLoading && (
                        <div className="text-sm text-gray-600">
                          Loading moment details...
                        </div>
                      )}

                      {selectedMomentDetailsError && (
                        <div className="text-sm text-red-600">
                          {selectedMomentDetailsError}
                        </div>
                      )}

                      {!selectedMomentDetailsLoading &&
                        !selectedMomentDetails &&
                        !selectedMomentDetailsError && (
                          <div className="text-sm text-gray-600">
                            No moment selected.
                          </div>
                        )}

                      {selectedMomentDetails && (
                        <>
                          <div>
                            <div className="text-xs font-medium text-gray-500 mb-1">
                              ID
                            </div>
                            <div className="font-mono text-xs break-all">
                              {selectedMomentDetails.id}
                            </div>
                          </div>

                          <div>
                            <div className="text-xs font-medium text-gray-500 mb-1">
                              Title
                            </div>
                            <div className="text-sm text-gray-900">
                              {selectedMomentDetails.title || "Untitled"}
                            </div>
                          </div>

                          <div>
                            <div className="text-xs font-medium text-gray-500 mb-1">
                              Summary
                            </div>
                            <div className="text-sm text-gray-700 whitespace-pre-wrap">
                              {selectedMomentDetails.summary || "N/A"}
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <div className="text-xs font-medium text-gray-500 mb-1">
                                Document
                              </div>
                              <div className="space-y-1">
                                <div className="font-mono text-xs break-all">
                                  {selectedMomentDetails.documentId || "N/A"}
                                </div>
                                {selectedMomentDetails.documentId && (
                                  <a
                                    className="text-xs text-blue-600 hover:text-blue-800"
                                    href={`/audit/ingestion/file/${encodeURIComponent(
                                      selectedMomentDetails.documentId
                                    )}`}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    Open ingestion file
                                  </a>
                                )}
                              </div>
                            </div>
                            <div>
                              <div className="text-xs font-medium text-gray-500 mb-1">
                                Parent
                              </div>
                              <div className="font-mono text-xs break-all">
                                {selectedMomentDetails.parentId || "Root"}
                              </div>
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <div className="text-xs font-medium text-gray-500 mb-1">
                                Created at
                              </div>
                              <div className="font-mono text-xs break-all">
                                {selectedMomentDetails.createdAt || "N/A"}
                              </div>
                            </div>
                            <div>
                              <div className="text-xs font-medium text-gray-500 mb-1">
                                Time range
                              </div>
                              {selectedMomentTimeRange ? (
                                <div className="font-mono text-xs break-all">
                                  {selectedMomentTimeRange.start} -{" "}
                                  {selectedMomentTimeRange.end}
                                </div>
                              ) : (
                                <div className="text-xs text-gray-500">N/A</div>
                              )}
                            </div>
                          </div>

                          <div className="border-t pt-3 space-y-2">
                            <div className="text-sm font-medium text-gray-900">
                              Classification
                            </div>

                            <div className="text-xs text-gray-600">
                              Moment kind:{" "}
                              <span className="font-mono">
                                {(selectedMomentDetails as any).momentKind ??
                                  "N/A"}
                              </span>
                            </div>

                            <div className="text-xs text-gray-600">
                              Subject:{" "}
                              <span className="font-mono">
                                {(selectedMomentDetails as any).isSubject
                                  ? "true"
                                  : "false"}
                              </span>
                              {(selectedMomentDetails as any).isSubject && (
                                <>
                                  {" "}
                                  <span className="text-gray-400">/</span>{" "}
                                  <span className="font-mono">
                                    {(selectedMomentDetails as any)
                                      .subjectKind ?? "N/A"}
                                  </span>
                                </>
                              )}
                            </div>

                            {typeof (selectedMomentDetails as any)
                              .subjectReason === "string" && (
                              <div>
                                <div className="text-xs font-medium text-gray-500 mb-1">
                                  Subject reason
                                </div>
                                <div className="text-xs text-gray-700 whitespace-pre-wrap">
                                  {(selectedMomentDetails as any).subjectReason}
                                </div>
                              </div>
                            )}

                            {Array.isArray(
                              (selectedMomentDetails as any).subjectEvidence
                            ) &&
                              (selectedMomentDetails as any).subjectEvidence
                                .length > 0 && (
                                <div>
                                  <div className="text-xs font-medium text-gray-500 mb-1">
                                    Subject evidence
                                  </div>
                                  <div className="space-y-1">
                                    {(
                                      (selectedMomentDetails as any)
                                        .subjectEvidence as any[]
                                    ).map((e, idx) => (
                                      <div
                                        key={idx}
                                        className="font-mono text-xs break-all text-gray-700"
                                      >
                                        {String(e)}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}

                            {Array.isArray(
                              (selectedMomentDetails as any).momentEvidence
                            ) &&
                              (selectedMomentDetails as any).momentEvidence
                                .length > 0 && (
                                <div>
                                  <div className="text-xs font-medium text-gray-500 mb-1">
                                    Moment evidence
                                  </div>
                                  <div className="space-y-1">
                                    {(
                                      (selectedMomentDetails as any)
                                        .momentEvidence as any[]
                                    ).map((e, idx) => (
                                      <div
                                        key={idx}
                                        className="font-mono text-xs break-all text-gray-700"
                                      >
                                        {String(e)}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                          </div>

                          {selectedMomentDetails.provenance && (
                            <div className="border-t pt-3 space-y-2">
                              <div className="text-sm font-medium text-gray-900">
                                Provenance
                              </div>

                              {typeof selectedMomentDetails.provenance
                                .streamId === "string" && (
                                <div className="text-xs text-gray-600">
                                  Stream:{" "}
                                  <span className="font-mono">
                                    {selectedMomentDetails.provenance.streamId}
                                  </span>
                                </div>
                              )}

                              {selectedMomentDetails.provenance.timeRange && (
                                <div className="text-xs text-gray-600">
                                  Time range:{" "}
                                  <span className="font-mono">
                                    {
                                      selectedMomentDetails.provenance.timeRange
                                        .start
                                    }
                                  </span>{" "}
                                  -{" "}
                                  <span className="font-mono">
                                    {
                                      selectedMomentDetails.provenance.timeRange
                                        .end
                                    }
                                  </span>
                                </div>
                              )}

                              {typeof selectedMomentDetails.provenance
                                .microPathsCount === "number" && (
                                <div className="text-xs text-gray-600">
                                  Micro paths:{" "}
                                  <span className="font-mono">
                                    {
                                      selectedMomentDetails.provenance
                                        .microPathsCount
                                    }
                                  </span>
                                </div>
                              )}

                              {Array.isArray(
                                selectedMomentDetails.provenance
                                  .discordMessageIdsSample
                              ) &&
                                selectedMomentDetails.provenance
                                  .discordMessageIdsSample.length > 0 && (
                                  <div>
                                    <div className="text-xs font-medium text-gray-500 mb-1">
                                      Discord message ids (sample)
                                    </div>
                                    <div className="font-mono text-xs break-all text-gray-700">
                                      {selectedMomentDetails.provenance.discordMessageIdsSample.join(
                                        ", "
                                      )}
                                    </div>
                                  </div>
                                )}
                            </div>
                          )}

                          <div className="border-t pt-3">
                            <div className="text-sm font-medium text-gray-900 mb-2">
                              Linkage
                            </div>

                            {!selectedMomentDetails.linkAuditLog && (
                              <div className="text-sm text-gray-600">
                                No linkage audit log stored on this moment.
                              </div>
                            )}

                            {selectedMomentDetails.linkAuditLog && (
                              <div className="space-y-3">
                                {typeof (
                                  selectedMomentDetails.linkAuditLog as any
                                )?.kind === "string" && (
                                  <div className="text-xs text-gray-600">
                                    Kind:{" "}
                                    <span className="font-mono">
                                      {
                                        (
                                          selectedMomentDetails.linkAuditLog as any
                                        ).kind
                                      }
                                    </span>
                                  </div>
                                )}

                                {typeof (
                                  selectedMomentDetails.linkAuditLog as any
                                )?.plugin === "string" && (
                                  <div className="text-xs text-gray-600">
                                    Plugin:{" "}
                                    <span className="font-mono">
                                      {
                                        (
                                          selectedMomentDetails.linkAuditLog as any
                                        ).plugin
                                      }
                                    </span>
                                  </div>
                                )}

                                {Array.isArray(
                                  (selectedMomentDetails.linkAuditLog as any)
                                    ?.candidates
                                ) && (
                                  <div>
                                    <div className="text-xs font-medium text-gray-500 mb-2">
                                      Candidates
                                    </div>
                                    <div className="space-y-2">
                                      {(
                                        (
                                          selectedMomentDetails.linkAuditLog as any
                                        ).candidates as any[]
                                      )
                                        .slice()
                                        .sort((a, b) => {
                                          const aScore =
                                            typeof a?.score === "number"
                                              ? a.score
                                              : -1;
                                          const bScore =
                                            typeof b?.score === "number"
                                              ? b.score
                                              : -1;
                                          if (aScore !== bScore) {
                                            return bScore - aScore;
                                          }
                                          const aId =
                                            typeof a?.id === "string"
                                              ? a.id
                                              : "";
                                          const bId =
                                            typeof b?.id === "string"
                                              ? b.id
                                              : "";
                                          return aId.localeCompare(bId);
                                        })
                                        .map((c, idx) => {
                                          const chosen = Boolean(c?.chosen);
                                          const score =
                                            typeof c?.score === "number"
                                              ? c.score.toFixed(3)
                                              : "N/A";
                                          const title =
                                            typeof c?.matchTitlePreview ===
                                              "string" && c.matchTitlePreview
                                              ? c.matchTitlePreview
                                              : typeof c?.matchTitlePreview ===
                                                "object"
                                              ? "N/A"
                                              : "N/A";
                                          const summary =
                                            typeof c?.matchSummaryPreview ===
                                              "string" && c.matchSummaryPreview
                                              ? c.matchSummaryPreview
                                              : null;
                                          const rejectReason =
                                            typeof c?.rejectReason === "string"
                                              ? c.rejectReason
                                              : null;

                                          return (
                                            <div
                                              key={`${idx}-${String(
                                                c?.id ?? ""
                                              )}`}
                                              className={`border rounded p-2 ${
                                                chosen
                                                  ? "bg-green-50 border-green-200"
                                                  : "bg-gray-50 border-gray-200"
                                              }`}
                                            >
                                              <div className="flex items-start justify-between gap-2">
                                                <div className="text-xs font-medium text-gray-900">
                                                  {chosen
                                                    ? "Chosen"
                                                    : "Candidate"}
                                                  :{" "}
                                                  <span className="font-normal">
                                                    {title}
                                                  </span>
                                                </div>
                                                <div className="text-xs font-mono text-gray-600">
                                                  {score}
                                                </div>
                                              </div>
                                              {summary && (
                                                <div className="text-xs text-gray-700 mt-1">
                                                  {summary}
                                                </div>
                                              )}
                                              <div className="text-xs text-gray-600 mt-1">
                                                {rejectReason ? (
                                                  <span>
                                                    Reject:{" "}
                                                    <span className="font-mono">
                                                      {rejectReason}
                                                    </span>
                                                  </span>
                                                ) : (
                                                  <span className="text-gray-500">
                                                    Reject: N/A
                                                  </span>
                                                )}
                                              </div>
                                              {typeof (
                                                c?.timelineFitAnswer ??
                                                c?.vetoAnswer
                                              ) === "string" && (
                                                <div className="text-xs text-gray-600 mt-1">
                                                  Timeline fit:{" "}
                                                  <span className="font-mono">
                                                    {String(
                                                      c?.timelineFitAnswer ??
                                                        c?.vetoAnswer
                                                    )}
                                                  </span>
                                                </div>
                                              )}
                                              {typeof c?.subjectDocumentId ===
                                                "string" && (
                                                <div className="text-xs text-gray-500 mt-1">
                                                  Document:{" "}
                                                  <span className="font-mono">
                                                    {c.subjectDocumentId}
                                                  </span>
                                                </div>
                                              )}
                                            </div>
                                          );
                                        })}
                                    </div>
                                  </div>
                                )}

                                <details className="border rounded p-2 bg-gray-50">
                                  <summary className="text-xs font-medium text-gray-700 cursor-pointer">
                                    Raw linkage audit log
                                  </summary>
                                  <pre className="text-xs overflow-auto max-h-64 mt-2 p-2 bg-white border rounded">
                                    {JSON.stringify(
                                      selectedMomentDetails.linkAuditLog,
                                      null,
                                      2
                                    )}
                                  </pre>
                                </details>
                              </div>
                            )}
                          </div>

                          <div className="border-t pt-3">
                            <div className="text-sm font-medium text-gray-900 mb-2">
                              Synthesis
                            </div>

                            {!Array.isArray(
                              selectedMomentDetails.documentAudit
                            ) ||
                            selectedMomentDetails.documentAudit.length === 0 ? (
                              <div className="text-sm text-gray-600">
                                No synthesis audit records found for this
                                document.
                              </div>
                            ) : (
                              <div className="space-y-2">
                                {selectedMomentDetails.documentAudit.map(
                                  (e) => {
                                    const message =
                                      typeof e?.payload?.message === "string"
                                        ? e.payload.message
                                        : null;
                                    const promptHash =
                                      typeof e?.payload?.promptHash16 ===
                                      "string"
                                        ? e.payload.promptHash16
                                        : null;
                                    const responsePreview =
                                      typeof e?.payload?.responsePreview ===
                                      "string"
                                        ? e.payload.responsePreview
                                        : null;
                                    const responseLength =
                                      typeof e?.payload?.responseLength ===
                                      "number"
                                        ? e.payload.responseLength
                                        : null;
                                    return (
                                      <div
                                        key={e.id}
                                        className="border rounded p-2 bg-gray-50"
                                      >
                                        <div className="text-xs text-gray-600">
                                          <span className="font-mono">
                                            {e.kind}
                                          </span>{" "}
                                          <span className="text-gray-400">
                                            {e.createdAt}
                                          </span>
                                        </div>
                                        {message && (
                                          <div className="text-xs text-gray-700 mt-1">
                                            {message}
                                          </div>
                                        )}
                                        {(promptHash ||
                                          responseLength !== null) && (
                                          <div className="text-xs text-gray-600 mt-1">
                                            {promptHash && (
                                              <span>
                                                Prompt:{" "}
                                                <span className="font-mono">
                                                  {promptHash}
                                                </span>{" "}
                                              </span>
                                            )}
                                            {responseLength !== null && (
                                              <span>
                                                Response chars:{" "}
                                                <span className="font-mono">
                                                  {responseLength}
                                                </span>
                                              </span>
                                            )}
                                          </div>
                                        )}
                                        {responsePreview && (
                                          <details className="mt-2">
                                            <summary className="text-xs font-medium text-gray-700 cursor-pointer">
                                              Response preview
                                            </summary>
                                            <pre className="text-xs overflow-auto max-h-48 mt-2 p-2 bg-white border rounded">
                                              {responsePreview}
                                            </pre>
                                          </details>
                                        )}
                                      </div>
                                    );
                                  }
                                )}
                              </div>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {graphData.length > 0 && (
                <div className="mt-6">
                  <h3 className="text-lg font-semibold mb-4">Audit Table</h3>
                  <div className="border rounded overflow-auto max-h-[600px]">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>ID</TableHead>
                          <TableHead>Document ID</TableHead>
                          <TableHead>Title</TableHead>
                          <TableHead>Summary</TableHead>
                          <TableHead>Parent ID</TableHead>
                          <TableHead>Created At</TableHead>
                          <TableHead>Author</TableHead>
                          <TableHead>Importance</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {graphData.map((moment) => (
                          <TableRow
                            key={moment.id}
                            onClick={() => setSelectedMomentId(moment.id)}
                            className={`cursor-pointer ${
                              selectedMomentId === moment.id ? "bg-blue-50" : ""
                            }`}
                          >
                            <TableCell className="font-mono text-xs">
                              {moment.id.substring(0, 8)}...
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {moment.documentId?.substring(0, 8) || "N/A"}...
                            </TableCell>
                            <TableCell className="max-w-[200px] truncate">
                              {moment.title || "Untitled"}
                            </TableCell>
                            <TableCell className="max-w-[300px] truncate">
                              N/A
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {moment.parentId
                                ? `${moment.parentId.substring(0, 8)}...`
                                : "Root"}
                            </TableCell>
                            <TableCell className="text-xs whitespace-nowrap">
                              {moment.createdAt
                                ? new Date(moment.createdAt).toLocaleString()
                                : "N/A"}
                            </TableCell>
                            <TableCell className="text-xs">N/A</TableCell>
                            <TableCell className="text-xs">
                              {moment.importance !== undefined
                                ? moment.importance.toFixed(3)
                                : "N/A"}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
