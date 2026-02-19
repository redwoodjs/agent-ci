import { z } from "zod";

const configSchema = z.object({
  /**
   * The URL of the OA-1 Bridge (Orchestrator).
   * Webhooks are sent here.
   */
  BRIDGE_URL: z.string().url(),

  /**
   * The secret used to sign GitHub webhooks.
   * Shared between the Simulation script and the Bridge.
   */
  GITHUB_WEBHOOK_SECRET: z.string().min(1),

  /**
   * The internal URL where the DTU Mock Server is reachable.
   * Simulation scripts seed this server.
   */
  DTU_URL: z.string().url().default("http://localhost:8910"),

  /**
   * The port the DTU Mock Server listens on.
   */
  DTU_PORT: z.coerce.number().default(8910),
});

export type Config = z.infer<typeof configSchema>;

export const config = configSchema.parse({
  BRIDGE_URL: process.env.BRIDGE_URL,
  GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
  DTU_URL: process.env.DTU_URL,
  DTU_PORT: process.env.DTU_PORT,
});
