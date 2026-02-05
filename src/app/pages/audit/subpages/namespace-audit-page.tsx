"use client";

import { useState, useEffect } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from "@/app/components/ui/card";
import { Input } from "@/app/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table";
import {
  getNamespaceSourceStatsAction,
  getMomentGraphNamespacePrefix,
} from "./actions";

type SourceStats = {
  source: "github" | "discord" | "cursor" | "antigravity" | "unknown";
  totalMoments: number;
  unparentedMoments: number;
  linkedMoments: number;
  avgImportance: number | null;
  lastUpdated: string | null;
};


export function NamespaceAuditPage() {
  const [stats, setStats] = useState<SourceStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNamespace, setSelectedNamespace] = useState<string | null>(
    null
  );
  const [prefix, setPrefix] = useState<string | null>(null);
  const [prefixOverride, setPrefixOverride] = useState<string>("");
  const [effectiveNamespace, setEffectiveNamespace] = useState<string | null>(
    null
  );

  const namespaceOptions = [
    { value: null, label: "Default (all namespaces)" },
    { value: "redwood:machinen", label: "redwood:machinen" },
    { value: "redwood:rwsdk", label: "redwood:rwsdk" },
    { value: "redwood:internal", label: "redwood:internal" },
  ];

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
    async function fetchStats() {
      setLoading(true);
      setError(null);
      try {
        const result = await getNamespaceSourceStatsAction({
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
          setError(result.error || "Failed to fetch stats");
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
  }, [selectedNamespace, prefixOverride]);

  const buildMomentsUrl = (source: "github" | "discord" | "cursor" | "antigravity" | "unknown") => {
    const params = new URLSearchParams();
    params.set("source", source);
    if (selectedNamespace) {
      params.set("namespace", selectedNamespace);
    }
    if (prefixOverride.trim().length > 0) {
      params.set("prefix", prefixOverride.trim());
    }
    return `/audit/namespace/moments?${params.toString()}`;
  };

  const formatDate = (dateString: string | null): string => {
    if (!dateString) return "N/A";
    try {
      const date = new Date(dateString);
      return date.toLocaleString();
    } catch {
      return dateString;
    }
  };

  const getSourceLabel = (source: string): string => {
    switch (source) {
      case "github":
        return "GitHub";
      case "discord":
        return "Discord";
      case "cursor":
        return "Cursor";
      case "antigravity":
        return "Antigravity";
      case "unknown":
        return "Unknown";
      default:
        return source;
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-3xl font-bold mb-8">Namespace Source Audit</h1>

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
                for queries.
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

      {/* Source Distribution Table */}
      <Card>
        <CardHeader>
          <CardTitle>Source Distribution</CardTitle>
          <CardDescription>
            Breakdown of moments by source type in the knowledge graph
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-center py-8">
              <p className="text-gray-500">Loading statistics...</p>
            </div>
          ) : error ? (
            <div className="p-4 bg-red-50 border border-red-200 rounded">
              <p className="text-red-600">{error}</p>
            </div>
          ) : stats.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              No moments found in the selected namespace.
            </div>
          ) : (
            <div className="border rounded overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Source</TableHead>
                    <TableHead>Total Moments</TableHead>
                    <TableHead>Unparented Moments</TableHead>
                    <TableHead>Linked Moments</TableHead>
                    <TableHead>Avg Importance</TableHead>
                    <TableHead>Last Updated</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stats.map((stat) => (
                    <TableRow key={stat.source}>
                      <TableCell className="font-medium">
                        {getSourceLabel(stat.source)}
                      </TableCell>
                      <TableCell>{stat.totalMoments.toLocaleString()}</TableCell>
                      <TableCell>
                        {stat.unparentedMoments.toLocaleString()}
                      </TableCell>
                      <TableCell>{stat.linkedMoments.toLocaleString()}</TableCell>
                      <TableCell>
                        {stat.avgImportance !== null
                          ? stat.avgImportance.toFixed(3)
                          : "N/A"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {formatDate(stat.lastUpdated)}
                      </TableCell>
                      <TableCell>
                        <a
                          href={buildMomentsUrl(stat.source)}
                          className="text-blue-600 hover:text-blue-800 text-sm font-medium"
                        >
                          View Moments
                        </a>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

