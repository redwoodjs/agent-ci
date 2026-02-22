import React from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/app/components/ui/card";

export function CostAnalysisCard({ costs }: { costs: any }) {
  if (!costs || costs.models.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Cost Analysis</CardTitle>
          <CardDescription>No LLM usage recorded for this run.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>AI Usage Cost Summary</CardTitle>
          <CardDescription>
            Estimated aggregate AI model costs based on token usage.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <div className="p-4 bg-slate-50 rounded-lg">
              <div className="text-sm text-slate-600 font-medium">
                Estimated Total AI Cost
              </div>
              <div className="text-2xl font-bold text-slate-900">
                ${costs.totalCostUsd.toFixed(4)}
              </div>
            </div>
            <div className="p-4 bg-blue-50 rounded-lg">
              <div className="text-sm text-blue-600 font-medium">
                Total API Calls
              </div>
              <div className="text-2xl font-bold text-blue-900">
                {costs.totalCallCount.toLocaleString()}
              </div>
            </div>
            <div className="p-4 bg-gray-50 rounded-lg">
              <div className="text-sm text-gray-600 font-medium">
                AI Tokens In
              </div>
              <div className="text-2xl font-bold text-gray-900">
                {costs.totalInputTokens.toLocaleString()}
              </div>
            </div>
            <div className="p-4 bg-gray-50 rounded-lg">
              <div className="text-sm text-gray-600 font-medium">
                AI Tokens Out
              </div>
              <div className="text-2xl font-bold text-gray-900">
                {costs.totalOutputTokens.toLocaleString()}
              </div>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead>
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Model
                  </th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Calls
                  </th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Avg Tokens (In/Out)
                  </th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Total Tokens
                  </th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Est. Cost
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {costs.models.map((m: any) => {
                  const n = m.callCount;
                  const inCi =
                    n > 1 ? 1.96 * (m.stdDevInputTokens / Math.sqrt(n)) : 0;
                  const outCi =
                    n > 1 ? 1.96 * (m.stdDevOutputTokens / Math.sqrt(n)) : 0;

                  return (
                    <tr key={m.model}>
                      <td className="px-4 py-2 whitespace-nowrap text-sm font-mono text-gray-900">
                        {m.model}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-sm text-right text-gray-600">
                        {m.callCount}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-sm text-right text-gray-600">
                        <div className="flex flex-col items-end">
                          <span>
                            {Math.round(m.avgInputTokens).toLocaleString()}
                            {inCi > 0 && (
                              <span className="text-gray-400 text-[10px] ml-1">
                                ±{Math.round(inCi)}
                              </span>
                            )}
                          </span>
                          <span>
                            {Math.round(m.avgOutputTokens).toLocaleString()}
                            {outCi > 0 && (
                              <span className="text-gray-400 text-[10px] ml-1">
                                ±{Math.round(outCi)}
                              </span>
                            )}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-sm text-right text-gray-600">
                        {(
                          m.totalInputTokens + m.totalOutputTokens
                        ).toLocaleString()}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-sm text-right font-medium text-slate-700">
                        ${m.totalCostUsd.toFixed(4)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Usage Heatmap (Buckets)</CardTitle>
          <CardDescription>
            Distribution of calls by input/output size buckets.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-100">
              <thead>
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                    Model
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                    In Bucket
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                    Out Bucket
                  </th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">
                    Calls
                  </th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">
                    Avg Tokens (In / Out)
                  </th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">
                    Total Cost
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {costs.buckets
                  .sort((a: any, b: any) => b.totalCostUsd - a.totalCostUsd)
                  .map((b: any, i: number) => {
                    const n = b.callCount;
                    const inCi =
                      n > 1 ? 1.96 * (b.stdDevInputTokens / Math.sqrt(n)) : 0;
                    const outCi =
                      n > 1 ? 1.96 * (b.stdDevOutputTokens / Math.sqrt(n)) : 0;

                    return (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="px-4 py-2 whitespace-nowrap text-xs font-mono text-gray-700">
                          {b.model}
                        </td>
                        <td className="px-4 py-2 whitespace-nowrap text-xs text-gray-600">
                          {b.inputBucket}
                        </td>
                        <td className="px-4 py-2 whitespace-nowrap text-xs text-gray-600">
                          {b.outputBucket}
                        </td>
                        <td className="px-4 py-2 whitespace-nowrap text-xs text-right text-gray-900 font-medium">
                          {b.callCount}
                        </td>
                        <td className="px-4 py-2 whitespace-nowrap text-xs text-right text-gray-600">
                          <div className="flex flex-col items-end">
                            <span>
                              {Math.round(b.avgInputTokens).toLocaleString()}
                              {inCi > 0 && (
                                <span className="text-gray-400 text-[10px] ml-1">
                                  ±{Math.round(inCi)}
                                </span>
                              )}
                            </span>
                            <span>
                              {Math.round(b.avgOutputTokens).toLocaleString()}
                              {outCi > 0 && (
                                <span className="text-gray-400 text-[10px] ml-1">
                                  ±{Math.round(outCi)}
                                </span>
                              )}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-2 whitespace-nowrap text-xs text-right text-slate-700">
                          ${b.totalCostUsd.toFixed(4)}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
