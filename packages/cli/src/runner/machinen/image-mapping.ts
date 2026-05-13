// Map a job to a machinen rootfs.
//
// See ADR 0004. Two outcomes:
//   - Repo has `.github/agent-ci.machinen.tar.gz` → that file is the
//     rootfs.
//   - Otherwise → use the pre-baked rootfs downloaded from agent-ci's
//     `machinen-rootfs-latest` GitHub release.

import { ensureMachinenRootfs, type ResolveOpts, type RootfsSource } from "./rootfs.ts";

export interface MachinenImage {
  /** Absolute path to the rootfs tarball machinen.boot() consumes. */
  rootfsPath: string;
  source: RootfsSource;
}

export async function resolveMachinenImage(opts: ResolveOpts): Promise<MachinenImage> {
  const rootfs = await ensureMachinenRootfs(opts);
  return { rootfsPath: rootfs.path, source: rootfs.source };
}
