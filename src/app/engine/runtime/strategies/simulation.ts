import { StorageStrategy, TransitionStrategy, Phase } from "../types";
import { SimulationDatabase } from "../../simulation/types";

export class ArtifactStorage implements StorageStrategy {
  // Using any because Kysely type is not directly accessible
  constructor(private runId: string, private simDb: any) {}

  async load<T>(phase: Phase, input: any): Promise<T | null> {
    const key = this.getKey(input);
    const row = await this.simDb
      .selectFrom("simulation_run_artifacts")
      .where("run_id", "=", this.runId)
      .where("phase", "=", phase.name)
      .where("artifact_key", "=", key)
      .select("output_json")
      .executeTakeFirst();

    if (row && row.output_json) {
      return JSON.parse(row.output_json) as T;
    }
    return null;
  }

  async save(phase: Phase, input: any, output: any): Promise<void> {
    const key = this.getKey(input);
    const inputJson = JSON.stringify(input);
    const outputJson = JSON.stringify(output);
    const now = new Date().toISOString();

    await this.simDb
      .insertInto("simulation_run_artifacts")
      .values({
        run_id: this.runId,
        phase: phase.name,
        artifact_key: key,
        input_json: inputJson,
        output_json: outputJson,
        created_at: now,
      })
      .onConflict((oc) =>
        oc.columns(["run_id", "phase", "artifact_key"]).doUpdateSet({
          output_json: outputJson,
          updated_at: now,
        })
      )
      .execute();
  }

  private getKey(input: any): string {
    if (typeof input === "string") return input;
    if (input && typeof input === "object") {
      if (typeof input.id === "string") return input.id;
      if (typeof input.r2Key === "string") return input.r2Key;
    }
    return "default";
  }
}

export class QueueTransition implements TransitionStrategy {
  constructor(
    private queue: { send(msg: any): Promise<void> },
    private runId: string
  ) {}

  async dispatchNext(
    nextPhase: string,
    output: any,
    input: any
  ): Promise<void> {
    if (output === null) {
      console.log(`[runtime] Phase output is null, stopping transition to ${nextPhase}`);
      return;
    }

    // Propagate the input (usually a pointer like r2Key) to the next phase
    await this.queue.send({
      jobType: "simulation-document",
      runId: this.runId,
      phase: nextPhase,
      r2Key: input, // Propagate the key/pointer as r2Key
    });
  }
}
