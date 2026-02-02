import { Phase, PipelineContext, RuntimeStrategies } from "./types";

export async function executePhase<TInput, TOutput>(
  phase: Phase<TInput, TOutput>,
  input: TInput,
  strategies: RuntimeStrategies,
  context: PipelineContext
): Promise<void> {
  const cached = await strategies.storage.load<TOutput>(phase, input);
  if (cached) {
    if (phase.next) {
      await strategies.transition.dispatchNext(phase.next, cached, input);
    }
    return;
  }

  const output = await phase.execute(input, context);

  await strategies.storage.save(phase, input, output);

  if (phase.next) {
    await strategies.transition.dispatchNext(phase.next, output, input);
  }
}
