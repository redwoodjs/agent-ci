import { Logger } from "../types";

export function createProductionLogger(): Logger {
  return {
    info: (message: string, data?: any) => {
      console.log(`[info] ${message}`, data ? JSON.stringify(data) : "");
    },
    warn: (message: string, data?: any) => {
      console.warn(`[warn] ${message}`, data ? JSON.stringify(data) : "");
    },
    error: (message: string, data?: any) => {
      console.error(`[error] ${message}`, data ? JSON.stringify(data) : "");
    },
    debug: (message: string, data?: any) => {
      console.debug(`[debug] ${message}`, data ? JSON.stringify(data) : "");
    },
  };
}
