"use client";

import { lazy, Suspense } from "react";

const Term = lazy(() => import("./Term"));

export function LazyTerm({ port }: { port: string }) {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      {/* <Term port={port} /> */}
    </Suspense>
  );
}
