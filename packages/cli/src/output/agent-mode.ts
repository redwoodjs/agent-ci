let quietFlag = false;

export function setQuietMode(value: boolean): void {
  quietFlag = value;
}

export function isAgentMode(): boolean {
  return quietFlag || process.env.AI_AGENT === "1";
}
