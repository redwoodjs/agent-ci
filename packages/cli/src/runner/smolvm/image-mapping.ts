// Map a Linux job's `runs-on:` labels to an OCI container image that smolvm
// will boot as a micro-VM. We default to the same actions-runner image the
// Docker backend uses so behavior matches between the two paths; users can
// override with AGENT_CI_SMOLVM_IMAGE for a custom base.

export const DEFAULT_SMOLVM_IMAGE = "ghcr.io/actions/actions-runner:latest";

const LABEL_TO_IMAGE: Record<string, string> = {
  // GitHub-hosted ubuntu-* labels all collapse to the same actions-runner
  // image — smolvm doesn't need a per-version image tag the way macOS does
  // because the Linux runner binary is version-agnostic. We keep the map
  // explicit so future divergence (e.g. ubuntu-24.04 → noble-pinned image)
  // is a one-line change.
  "ubuntu-22.04": DEFAULT_SMOLVM_IMAGE,
  "ubuntu-24.04": DEFAULT_SMOLVM_IMAGE,
  "ubuntu-latest": DEFAULT_SMOLVM_IMAGE,
  ubuntu: DEFAULT_SMOLVM_IMAGE,
  linux: DEFAULT_SMOLVM_IMAGE,
};

export interface ImageResolution {
  image: string;
  /** True when we recognized a specific label; false when we fell back. */
  exact: boolean;
  /** The label we matched on (or the first one we considered when falling back). */
  matchedLabel: string | null;
}

export function resolveSmolvmImage(labels: string[]): ImageResolution {
  const override = process.env.AGENT_CI_SMOLVM_IMAGE?.trim();
  if (override) {
    return { image: override, exact: true, matchedLabel: null };
  }
  for (const label of labels) {
    const mapped = LABEL_TO_IMAGE[label.toLowerCase()];
    if (mapped) {
      return { image: mapped, exact: true, matchedLabel: label };
    }
  }
  const firstLinuxLike = labels.find((l) => /^(ubuntu|linux)/i.test(l)) ?? labels[0] ?? null;
  return { image: DEFAULT_SMOLVM_IMAGE, exact: false, matchedLabel: firstLinuxLike };
}
