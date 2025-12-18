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

export function getMomentGraphNamespacePrefixFromEnv(
  env: unknown
): string | null {
  const raw = (env as any)?.MOMENT_GRAPH_NAMESPACE_PREFIX;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.endsWith(":") ? trimmed.slice(0, -1) : trimmed;
}

export function applyMomentGraphNamespacePrefix(
  namespace: string | null,
  env: unknown
): string | null {
  if (!namespace) {
    return namespace;
  }
  const prefix = getMomentGraphNamespacePrefixFromEnv(env);
  if (!prefix) {
    return namespace;
  }
  const prefixWithDelimiter = `${prefix}:`;
  if (namespace.startsWith(prefixWithDelimiter)) {
    return namespace;
  }
  return `${prefixWithDelimiter}${namespace}`;
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
