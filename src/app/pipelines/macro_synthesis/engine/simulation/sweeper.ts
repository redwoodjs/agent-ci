import { recoverZombiesForPhase } from "../../../../engine/simulation/resiliency";
import type { SimulationDbContext } from "../../../../engine/simulation/types";

export async function recoverMacroSynthesisZombies(
  context: SimulationDbContext,
  input: { runId: string }
): Promise<void> {
  // Timeout: 5 minutes default is fine, but maybe 10 for macro synthesis?
  // Let's stick to default 5m for now as synthesis chunks should be relatively fast (<60s)
  await recoverZombiesForPhase(context, {
    runId: input.runId,
    phase: "macro_synthesis",
    timeoutMs: 10 * 60 * 1000, // 10 minutes
  });
}
