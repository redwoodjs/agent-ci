import { config } from "../config.js";
import { bootstrapAndReturnApp } from "./index.js";
import { getDtuLogPath, setWorkingDirectory, DTU_ROOT } from "./logger.js";
import path from "node:path";

let workingDir = process.env.OA_WORKING_DIR;
if (workingDir) {
  if (!path.isAbsolute(workingDir)) {
    workingDir = path.resolve(DTU_ROOT, workingDir);
  }
  setWorkingDirectory(workingDir);
}

bootstrapAndReturnApp()
  .then((app) => {
    app.listen(config.DTU_PORT, "0.0.0.0", () => {
      console.log(
        `[DTU] OA-RUN-1 Mock GitHub API server running at http://0.0.0.0:${config.DTU_PORT}`,
      );
      console.log(`[DTU] Logging to ${getDtuLogPath()}`);
    });
  })
  .catch((err: any) => {
    console.error("[DTU] Failed to start:", err);
    process.exit(1);
  });
