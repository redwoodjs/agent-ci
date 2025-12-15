export function getMomentGraphNamespaceFromEnv(env: unknown): string | null {
  const raw = (env as any)?.MOMENT_GRAPH_NAMESPACE;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed;
}

export function qualifyName(
  baseName: string,
  namespace: string | null
): string {
  if (!namespace) {
    return baseName;
  }
  return `${namespace}:${baseName}`;
}
