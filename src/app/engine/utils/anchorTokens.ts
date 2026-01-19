export function extractAnchorTokens(text: string, maxTokens: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  function add(token: string) {
    const t = token.trim();
    if (!t) {
      return;
    }
    if (seen.has(t)) {
      return;
    }
    seen.add(t);
    out.push(t);
  }

  const canon = text.match(/mchn:\/\/[a-z]+\/[^\s)\]]+/g) ?? [];
  for (const m of canon) {
    add(m);
    if (out.length >= maxTokens) {
      return out;
    }
  }

  const issueRefs = text.match(/#\d{2,6}/g) ?? [];
  for (const m of issueRefs) {
    add(m);
    if (out.length >= maxTokens) {
      return out;
    }
  }

  const backtick = text.match(/`([^`]{1,80})`/g) ?? [];
  for (const m of backtick) {
    const inner = m.slice(1, -1);
    add(inner);
    if (out.length >= maxTokens) {
      return out;
    }
  }

  return out;
}
