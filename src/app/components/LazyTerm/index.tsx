"use client";

import { lazy, Suspense } from "react";

const Term = lazy(() => import("./Xterm"));

export function LazyTerm({ containerId }: { containerId: string }) {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <Term containerId={containerId} />
    </Suspense>
  );
}
