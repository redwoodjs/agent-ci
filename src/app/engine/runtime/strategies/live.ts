import { Phase, StorageStrategy, TransitionStrategy } from "../types";

export class NoOpStorage implements StorageStrategy {
  async load<T>(phase: Phase, input: any): Promise<T | null> {
    return null;
  }
  async save(phase: Phase, input: any, output: any): Promise<void> {
    // No-op
  }
}

export class QueueTransition implements TransitionStrategy {
  constructor(private queue: { send(msg: any): Promise<void> }) {}

  async dispatchNext(nextPhase: string, output: any, input: any): Promise<void> {
    if (output === null) {
      console.log(
        `[runtime] Phase output is null, stopping transition to ${nextPhase}`
      );
      return;
    }

    await this.queue.send({
      jobType: "execute_phase",
      phase: nextPhase,
      input: output,
    });
  }
}

export class DirectTransition implements TransitionStrategy {
  async dispatchNext(nextPhase: string, output: any, input: any): Promise<void> {
    console.warn(
      `DirectTransition: dispatchNext(${nextPhase}) called but not implemented. Requires Phase Registry.`
    );
  }
}
