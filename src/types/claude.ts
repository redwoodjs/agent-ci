export const CLAUDE_MODELS = [
  "default",
  "sonnet",
  "opus",
  "haiku",
  "sonnet[1m]",
  "opusplan",
] as const;

export type ClaudeModel = (typeof CLAUDE_MODELS)[number];

export function isClaudeModel(value: unknown): value is ClaudeModel {
  return (
    typeof value === "string" &&
    (CLAUDE_MODELS as readonly string[]).includes(value)
  );
}
