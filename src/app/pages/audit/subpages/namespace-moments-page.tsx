import { Suspense } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from "@/app/components/ui/card";
import { SearchInput } from "./search-input";
import { ViewInGraphButton } from "./view-in-graph-button";
import { searchMomentsByTextAction } from "./actions";
import {
  getMomentGraphNamespacePrefixFromEnv,
  applyMomentGraphNamespacePrefixValue,
} from "@/app/engine/momentGraphNamespace";
import { env } from "cloudflare:workers";

type MomentSample = {
  id: string;
  documentId: string;
  title: string;
  summary: string;
  parentId?: string;
  importance?: number;
  createdAt: string;
  author: string;
};

export function NamespaceMomentsPage({ request }: { request: Request }) {
  const url = new URL(request.url);
  const source = url.searchParams.get("source") || null;
  const namespace = url.searchParams.get("namespace") || null;
  const prefix = url.searchParams.get("prefix") || null;
  const query = url.searchParams.get("q") || "";
  const pageParam = url.searchParams.get("page") || "1";
  const page = Math.max(1, Number.parseInt(pageParam, 10) || 1);

  const validSource = (source === "github" ||
    source === "discord" ||
    source === "cursor" ||
    source === "antigravity" ||
    source === "unknown"
    ? source
    : null) as "github" | "discord" | "cursor" | "antigravity" | "unknown" | null;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6">
        <a
          href="/audit/namespace"
          className="text-blue-600 hover:text-blue-800 text-sm font-medium"
        >
          ← Back to Namespace Audit
        </a>
      </div>

      <h1 className="text-3xl font-bold mb-8">Namespace Moments</h1>

      <Suspense
        fallback={
          <>
            <SystemContextSkeleton />
            <SearchSectionSkeleton />
            <MomentsListSkeleton />
          </>
        }
      >
        <NamespaceMomentsContent
          source={validSource}
          namespace={namespace}
          prefix={prefix}
          query={query}
          page={page}
        />
      </Suspense>
    </div>
  );
}

async function NamespaceMomentsContent({
  source,
  namespace,
  prefix,
  query,
  page,
}: {
  source: "github" | "discord" | "cursor" | "antigravity" | "unknown" | null;
  namespace: string | null;
  prefix: string | null;
  query: string;
  page: number;
}) {
  const envCloudflare = env as Cloudflare.Env;
  const envPrefix = getMomentGraphNamespacePrefixFromEnv(envCloudflare);
  const prefixOverride =
    typeof prefix === "string" && prefix.trim().length > 0
      ? prefix.trim()
      : null;
  const effectivePrefix = prefixOverride ?? envPrefix;
  const effectiveNamespace = applyMomentGraphNamespacePrefixValue(
    namespace,
    effectivePrefix
  );

  const pageSize = 50;
  const offset = (page - 1) * pageSize;

  const searchResult = await searchMomentsByTextAction({
    query: query || "",
    source: source,
    limit: pageSize,
    offset: offset,
    momentGraphNamespace: namespace,
    momentGraphNamespacePrefix: prefix,
  });

  const moments =
    searchResult.success && searchResult.moments ? searchResult.moments : [];
  const totalCount = searchResult.success ? searchResult.totalCount : 0;
  const totalPages = Math.max(1, Math.ceil((totalCount || 0) / pageSize));

  const pagination = {
    moments,
    totalCount: totalCount || 0,
    page,
    totalPages,
  };

  return (
    <>
      <SystemContext
        prefix={envPrefix}
        prefixOverride={prefixOverride}
        namespace={namespace}
        effectiveNamespace={effectiveNamespace}
      />
      <SearchSection
        source={source}
        namespace={namespace}
        prefix={prefix}
        query={query}
      />
      <MomentsList
        moments={moments}
        totalCount={totalCount || 0}
        page={page}
        totalPages={totalPages}
        source={source}
        namespace={namespace}
        prefix={prefix}
        query={query}
      />
    </>
  );
}

function SystemContext({
  prefix,
  prefixOverride,
  namespace,
  effectiveNamespace,
}: {
  prefix: string | null;
  prefixOverride: string | null;
  namespace: string | null;
  effectiveNamespace: string | null;
}) {
  return (
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
          {prefixOverride && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Namespace Prefix Override
              </label>
              <div className="p-3 bg-yellow-50 rounded border font-mono text-sm text-yellow-900">
                {prefixOverride}
              </div>
            </div>
          )}
          {namespace && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Selected Namespace
              </label>
              <div className="p-3 bg-gray-50 rounded border font-mono text-sm">
                {namespace}
              </div>
            </div>
          )}
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
  );
}

function SearchSection({
  source,
  namespace,
  prefix,
  query,
}: {
  source: "github" | "discord" | "cursor" | "antigravity" | "unknown" | null;
  namespace: string | null;
  prefix: string | null;
  query: string;
}) {
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Search Moments</CardTitle>
        <CardDescription>
          Search across title, summary, author, and document ID
        </CardDescription>
      </CardHeader>
      <CardContent>
        <SearchInput
          source={source}
          namespace={namespace}
          prefix={prefix}
          initialQuery={query}
        />
      </CardContent>
    </Card>
  );
}

function MomentsList({
  moments,
  totalCount,
  page,
  totalPages,
  source,
  namespace,
  prefix,
  query,
}: {
  moments: MomentSample[];
  totalCount: number;
  page: number;
  totalPages: number;
  source: "github" | "discord" | "cursor" | "antigravity" | "unknown" | null;
  namespace: string | null;
  prefix: string | null;
  query: string;
}) {
  const formatDate = (dateString: string | null): string => {
    if (!dateString) return "N/A";
    try {
      const date = new Date(dateString);
      return date.toLocaleString();
    } catch {
      return dateString;
    }
  };

  const getSourceLabel = (source: string | null): string => {
    if (!source) return "All Sources";
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

  const buildUrl = (newPage: number, newQuery?: string) => {
    const params = new URLSearchParams();
    if (source) params.set("source", source);
    if (namespace) params.set("namespace", namespace);
    if (prefix) params.set("prefix", prefix);
    if (newQuery !== undefined) {
      if (newQuery) params.set("q", newQuery);
    } else if (query) {
      params.set("q", query);
    }
    if (newPage > 1) params.set("page", newPage.toString());
    return `/audit/namespace/moments?${params.toString()}`;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Moments {source && `(${getSourceLabel(source)})`}
        </CardTitle>
        <CardDescription>
          {query
            ? `Found ${totalCount.toLocaleString()} moments matching "${query}"`
            : `Showing ${totalCount.toLocaleString()} moments`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {moments.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            {query
              ? `No moments found matching "${query}"`
              : "No moments found"}
          </div>
        ) : (
          <>
            <div className="space-y-3 mb-6">
              {moments.map((moment) => (
                <div
                  key={moment.id}
                  className="border rounded p-4 bg-white hover:bg-gray-50"
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex-1">
                      <div className="font-medium text-sm text-gray-900">
                        {moment.title}
                      </div>
                      <div className="text-xs text-gray-500 mt-1">
                        {moment.summary}
                      </div>
                    </div>
                    <div className="text-xs text-gray-500 whitespace-nowrap">
                      {moment.importance !== undefined
                        ? moment.importance.toFixed(3)
                        : "N/A"}
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-gray-500 mt-2">
                    <span>
                      ID:{" "}
                      <span className="font-mono">
                        {moment.id.substring(0, 8)}...
                      </span>
                    </span>
                    <span>Author: {moment.author}</span>
                    <span>
                      {moment.parentId ? (
                        <span className="text-blue-600">
                          Linked (parent: {moment.parentId.substring(0, 8)}...)
                        </span>
                      ) : (
                        <span className="text-green-600">Root moment</span>
                      )}
                    </span>
                    <span>{formatDate(moment.createdAt)}</span>
                  </div>
                  <div className="text-xs text-gray-400 mt-1 font-mono truncate">
                    {moment.documentId}
                  </div>
                  <ViewInGraphButton
                    momentId={moment.id}
                    namespace={namespace}
                    prefix={prefix}
                  />
                </div>
              ))}
            </div>

            {totalPages > 1 && (
              <div className="flex justify-between items-center mt-6 pt-4 border-t">
                <div className="text-sm text-gray-500">
                  Page {page} of {totalPages} (showing {moments.length} of{" "}
                  {totalCount.toLocaleString()} moments)
                </div>
                <div className="flex gap-2">
                  {page > 1 && (
                    <a
                      href={buildUrl(page - 1)}
                      className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 text-sm"
                    >
                      Previous
                    </a>
                  )}
                  {page < totalPages && (
                    <a
                      href={buildUrl(page + 1)}
                      className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
                    >
                      Next
                    </a>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SystemContextSkeleton() {
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>System Context</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i}>
              <div className="h-4 w-32 bg-gray-200 rounded animate-pulse mb-2" />
              <div className="h-10 w-full bg-gray-200 rounded animate-pulse" />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function SearchSectionSkeleton() {
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Search Moments</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-10 w-full bg-gray-200 rounded animate-pulse" />
      </CardContent>
    </Card>
  );
}

function MomentsListSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Moments</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="border rounded p-4 bg-white"
            >
              <div className="h-4 w-3/4 bg-gray-200 rounded animate-pulse mb-2" />
              <div className="h-3 w-full bg-gray-200 rounded animate-pulse mb-2" />
              <div className="h-3 w-2/3 bg-gray-200 rounded animate-pulse" />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
