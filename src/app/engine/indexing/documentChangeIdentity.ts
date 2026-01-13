export type DocumentChangeIdentity = {
  etag: string;
};

export function computeDocumentChangeIdentityFromEtag(etag: string): DocumentChangeIdentity | null {
  const v = typeof etag === "string" ? etag.trim() : "";
  if (!v) {
    return null;
  }
  return { etag: v };
}

export function isDocumentChangedByEtag(input: {
  previousEtag: string | null;
  nextEtag: string | null;
}): boolean {
  const prev = typeof input.previousEtag === "string" ? input.previousEtag.trim() : "";
  const next = typeof input.nextEtag === "string" ? input.nextEtag.trim() : "";
  if (!next) {
    return true;
  }
  if (!prev) {
    return true;
  }
  return prev !== next;
}

