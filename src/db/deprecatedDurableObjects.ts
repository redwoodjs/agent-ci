import { DurableObject } from "cloudflare:workers";
import { SqliteDurableObject } from "rwsdk/db";

// These classes are deprecated and are only defined here to satisfy
// the Cloudflare migration process. They are being deleted by migration v2
// in wrangler.jsonc. This file can be removed after this migration
// has been successfully applied to the production environment.

export class Container extends DurableObject {}
export class MachinenContainer extends DurableObject {}
export class Sandbox extends DurableObject {}
export class ProcessLog extends SqliteDurableObject {}
export class RawDiscordDatabase extends SqliteDurableObject {}
