export function inferSimulationRunPrefixEnvLabel(env: unknown): string {
  const raw =
    (env as any)?.MACHINEN_ENV ??
    (env as any)?.CLOUDFLARE_ENV ??
    (env as any)?.NODE_ENV ??
    "";
  const v = String(raw).trim().toLowerCase();
  if (!v) {
    return "local";
  }
  if (v === "production" || v.includes("prod")) {
    return "prod";
  }
  if (v.includes("dev") || v === "development") {
    return "dev";
  }
  if (v.includes("stage") || v.includes("staging")) {
    return "staging";
  }
  return "local";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function computeSimulationRunPrefixBase(input: {
  env: unknown;
  now: Date;
}): string {
  const label = inferSimulationRunPrefixEnvLabel(input.env);
  const d = input.now;
  const year = d.getUTCFullYear();
  const month = pad2(d.getUTCMonth() + 1);
  const day = pad2(d.getUTCDate());
  const hour = pad2(d.getUTCHours());
  const minute = pad2(d.getUTCMinutes());
  return `${label}-${year}-${month}-${day}-${hour}-${minute}`;
}
