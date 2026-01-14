export type SourceType =
  | "GitHub PR"
  | "GitHub Issue"
  | "Release"
  | "Discord"
  | "Cursor"
  | "Unknown";

export interface MomentDay {
  date: string; // YYYY-MM-DD format
  count: number;
}
