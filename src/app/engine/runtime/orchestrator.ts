import { Phase, PipelineContext, RuntimeStrategies } from "./types";

export async function executePhase<TInput, TOutput>(
  phase: Phase<TInput, TOutput>,
  input: TInput,
  strategies: RuntimeStrategies,
  context: PipelineContext
): Promise<void> {
  context.storage = strategies.storage;
  
  const output = await phase.execute(input, context);

  await strategies.storage.save(phase, input, output);

  if (phase.next) {
    await strategies.transition.dispatchNext(phase.next, output, input);
  }
}
