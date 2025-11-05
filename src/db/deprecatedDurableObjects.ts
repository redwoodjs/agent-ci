import { DurableObject } from "cloudflare:workers";
import { SqliteDurableObject } from "rwsdk/db";

// These classes are kept only to satisfy Cloudflare's deployment checks.
// There are live Durable Object instances in production that depend on these classes.
// We cannot delete them via migration because they were never properly exported
// in the previous deployment. They are not used by the application and will
// remain as orphaned objects in the Cloudflare environment.

export class Container extends DurableObject {}
export class MachinenContainer extends DurableObject {}
export class Sandbox extends DurableObject {}
export class ProcessLog extends SqliteDurableObject {}
export class RawDiscordDatabase extends SqliteDurableObject {}

