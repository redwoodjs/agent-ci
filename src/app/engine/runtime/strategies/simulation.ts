import { StorageStrategy, TransitionStrategy, Phase } from "../types";
import { SimulationDatabase } from "../../simulation/types";

export class ArtifactStorage implements StorageStrategy {
  // Using any because Kysely type is not directly accessible
  constructor(
    private runId: string,
    private simDb: any,
    private env: Cloudflare.Env
  ) {}

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
      const output = row.output_json as any;
      if (
        output &&
        typeof output === "object" &&
        output.__offloaded_at__ === "R2"
      ) {
        const bucket = this.env.MACHINEN_BUCKET;
        
        // R2 Retry Logic: Local Miniflare R2 can fail with 'Unspecified error' under high concurrency.
        let object: R2Object | null = null;
        let attempts = 0;
        const maxAttempts = 3;
        
        while (attempts < maxAttempts) {
          try {
            object = await bucket.get(output.key);
            break;
          } catch (error) {
            attempts++;
            if (attempts >= maxAttempts) throw error;
            const delay = Math.pow(2, attempts) * 100; // 200ms, 400ms
            console.warn(`[ArtifactStorage] R2 get failed (attempt ${attempts}), retrying in ${delay}ms...`, output.key);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }

        if (!object) {
          const msg = `[ArtifactStorage] Offloaded artifact missing: ${output.key} for ${phase.name}/${key}`;
          console.error(msg);
          
          // Log to events table
          const id = crypto.randomUUID();
          const now = new Date().toISOString();
          await this.simDb
            .insertInto("simulation_run_events")
            .values({
              id,
              run_id: this.runId,
              level: "error",
              kind: "artifact.missing_offload",
              payload_json: JSON.stringify({
                message: msg,
                phase: phase.name,
                r2Key: key, // usually the r2Key is the artifact key for document phases
                offloadKey: output.key
              }),
              created_at: now,
            })
            .execute();

          return null; 
        }
        const text = await (object as any).text();
        return JSON.parse(text) as T;
      }
      return output as T;
    }
    
    // Explicitly null if not found in DB
    return null;
  }

  async save(phase: Phase, input: any, output: any): Promise<void> {
    const key = this.getKey(input);
    let outputJson = JSON.stringify(output);
    const now = new Date().toISOString();

    // SQLITE_TOOBIG check / D1 1MB limit check.
    // We use a 512KB threshold for safety.
    if (outputJson.length > 512 * 1024) {
      const r2Key = `artifacts/${this.runId}/${phase.name}/${key}.json`;
      const bucket = this.env.MACHINEN_BUCKET;
      await bucket.put(r2Key, outputJson, {
        httpMetadata: { contentType: "application/json" },
      });
      outputJson = JSON.stringify({
        __offloaded_at__: "R2",
        key: r2Key,
      });
    }

    const inputJson = JSON.stringify(input);

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
      .onConflict((oc: any) =>
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
