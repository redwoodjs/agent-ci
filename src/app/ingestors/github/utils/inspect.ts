// @ts-ignore - browser-util-inspect doesn't have types
import inspect from "browser-util-inspect";

export function formatLog(...args: any[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") {
        return arg;
      }
      return inspect(arg);
    })
    .join(" ");
}
