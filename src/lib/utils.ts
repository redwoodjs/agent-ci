import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Formats a number for UI display.
 * For numbers < 10,000, returns a locale-formatted string with commas.
 * For numbers >= 10,000, returns a compact representation (e.g., 1.2M, 850K).
 */
export function formatCompactNumber(n: number): string {
  if (n < 10000) {
    return Math.round(n).toLocaleString();
  }
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    compactDisplay: "short",
    maximumFractionDigits: 1,
  }).format(n);
}
