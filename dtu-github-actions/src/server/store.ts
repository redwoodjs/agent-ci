import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

const CACHE_DIR = config.DTU_CACHE_DIR;
const CACHES_FILE = path.join(CACHE_DIR, "caches.json");

export const state = {
  jobs: new Map<string, any>(),
  sessions: new Map<string, any>(),
  messageQueues: new Map<string, any[]>(),
  pendingPolls: new Map<string, { res: http.ServerResponse; baseUrl: string }>(),
  timelines: new Map<string, any[]>(),
  logs: new Map<string, string[]>(),

  // Concurrency Maps
  // runnerName -> logDirectory
  runnerLogs: new Map<string, string>(),
  // sessionId -> runnerName
  sessionToRunner: new Map<string, string>(),
  // planId -> step-output.log path
  planToLogPath: new Map<string, string>(),

  // cacheKey -> { version: string, archiveLocation: string, size: number }
  caches: new Map<string, { version: string; archiveLocation: string; size: number }>(),
  // cacheId (number) -> { tempPath: string, key: string, version: string }
  pendingCaches: new Map<number, { tempPath: string; key: string; version: string }>(),

  loadCachesFromDisk() {
    if (fs.existsSync(CACHES_FILE)) {
      try {
        const data = fs.readFileSync(CACHES_FILE, "utf-8");
        const parsed = JSON.parse(data);
        this.caches = new Map(Object.entries(parsed));
      } catch (e) {
        console.warn("[DTU] Failed to load caches from disk:", e);
      }
    }
  },

  saveCachesToDisk() {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    try {
      const obj = Object.fromEntries(this.caches);
      fs.writeFileSync(CACHES_FILE, JSON.stringify(obj, null, 2), "utf-8");
    } catch (e) {
      console.warn("[DTU] Failed to save caches to disk:", e);
    }
  },

  reset() {
    this.jobs.clear();
    this.sessions.clear();
    this.messageQueues.clear();
    this.pendingPolls.clear();
    this.timelines.clear();
    this.logs.clear();
    this.runnerLogs.clear();
    this.sessionToRunner.clear();
    this.planToLogPath.clear();
    this.pendingCaches.clear();
  },
};

// Auto-load on startup
state.loadCachesFromDisk();
