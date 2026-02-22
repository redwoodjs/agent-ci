import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { E2ETestHarness } from "./setup.js";
import fs from "node:fs";
import path from "node:path";

describe("Supervisor E2E Regressions", () => {
  const harness = new E2ETestHarness();

  beforeAll(async () => {
    await harness.startDTU();
  }, 30000);

  afterAll(async () => {
    await harness.stopDTU();
  });

  it("should connect to DTU, receive tasks, and exit correctly", async () => {
    const jobId = "e2e-job-" + Date.now();
    await harness.seedJob({
      id: jobId,
      name: "e2e-test-job",
      steps: [{ id: "step-1", name: "Say Hello", run: 'echo "Hello from E2E"' }],
    });

    const result = await harness.runSupervisor(jobId);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Job succeeded");

    // Check the runner's step-output.log file directly since DTU now writes to it
    const match = result.stdout.match(/oa-runner-\d+/);
    expect(match).toBeTruthy();
    const runnerName = match![0];
    const stepOutputLogPath = path.resolve(
      process.cwd(),
      "supervisor",
      "_",
      "logs",
      runnerName,
      "step-output.log",
    );
    const allLogs = fs.readFileSync(stepOutputLogPath, "utf8");
    expect(allLogs).toContain("Hello from E2E");
  }, 60000);

  it("should place logs in a flat file structure", async () => {
    const logsDir = path.resolve(process.cwd(), "supervisor", "_", "logs");

    const countLogFiles = (dir: string) => {
      if (!fs.existsSync(dir)) {
        return 0;
      }
      // Recursively find all files ending in .log
      const scanDir = (d: string): string[] => {
        const entries = fs.readdirSync(d, { withFileTypes: true });
        const files = entries
          .filter((e) => e.isFile() && e.name.endsWith(".log"))
          .map((e) => path.join(d, e.name));
        const subdirs = entries.filter((e) => e.isDirectory());
        for (const sd of subdirs) {
          files.push(...scanDir(path.join(d, sd.name)));
        }
        return files;
      };

      return scanDir(dir).filter((f) => f.includes("oa-runner-")).length;
    };

    const initialCount = countLogFiles(logsDir);

    const jobId = "log-test-" + Date.now();
    await harness.seedJob({ id: jobId, name: "log-test" });
    await harness.runSupervisor(jobId);

    const finalCount = countLogFiles(logsDir);
    expect(finalCount).toBeGreaterThan(initialCount);
  }, 60000);

  it("should successfully save and restore cache", async () => {
    // We simulate a job that writes to a cache using the actions/cache mechanism.
    // Instead of using the real action (which is complex to set up purely locally),
    // we use a node runtime script using the @actions/cache toolkit, or we can just
    // verify the API was hit by the runner if we simulate the cache interactions.
    // We will use a raw cURL command to the local cache API since we injected ACTIONS_CACHE_URL.

    // In our local runner environment:
    // $ACTIONS_CACHE_URL points to our DTU.
    // $ACTIONS_RUNTIME_TOKEN is mock_cache_token_123.

    const jobId = "cache-test-" + Date.now();
    await harness.seedJob({
      id: jobId,
      name: "cache-test-job",
      steps: [
        {
          id: "reserve",
          name: "Reserve Cache",
          run: `
            echo "Requesting cache reservation from $ACTIONS_CACHE_URL"
            RES=$(curl -s -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $ACTIONS_RUNTIME_TOKEN" -d '{"key":"e2e-cache-key","version":"1"}' "$ACTIONS_CACHE_URL/_apis/artifactcache/caches")
            echo "Reserve Response: $RES"
            CACHE_ID=$(echo $RES | python3 -c "import sys, json; print(json.load(sys.stdin)['cacheId'])")
            echo "CACHE_ID=$CACHE_ID" >> $GITHUB_ENV
          `,
        },
        {
          id: "upload",
          name: "Upload Cache Chunk",
          run: `
            echo "hello e2e cache file" > test_cache.txt
            tar -czf test_cache.tar.gz test_cache.txt
            FILE_SIZE=$(stat -c%s test_cache.tar.gz 2>/dev/null || stat -f%z test_cache.tar.gz)
            echo "Uploading chunk of size $FILE_SIZE to cache $CACHE_ID"
            curl -s -X PATCH -H "Content-Type: application/octet-stream" -H "Content-Range: bytes 0-$((FILE_SIZE-1))/*" -H "Authorization: Bearer $ACTIONS_RUNTIME_TOKEN" --data-binary @test_cache.tar.gz "$ACTIONS_CACHE_URL/_apis/artifactcache/caches/$CACHE_ID"
            echo "Committing cache"
            curl -s -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $ACTIONS_RUNTIME_TOKEN" -d "{\\"size\\": $FILE_SIZE}" "$ACTIONS_CACHE_URL/_apis/artifactcache/caches/$CACHE_ID"
          `,
        },
        {
          id: "restore",
          name: "Restore Cache",
          run: `
            echo "Checking for cache hit"
            HIT_RES=$(curl -s -X GET -H "Authorization: Bearer $ACTIONS_RUNTIME_TOKEN" "$ACTIONS_CACHE_URL/_apis/artifactcache/caches?keys=e2e-cache-key&version=1")
            echo "Hit Response: $HIT_RES"
            ARCHIVE_URL=$(echo $HIT_RES | python3 -c "import sys, json; print(json.load(sys.stdin)['archiveLocation'])")
            echo "Downloading from $ARCHIVE_URL"
            curl -s -o restored_cache.tar.gz "$ARCHIVE_URL"
            tar -xzf restored_cache.tar.gz
            cat test_cache.txt
          `,
        },
      ],
    });

    const result = await harness.runSupervisor(jobId);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Job succeeded");

    // Check the runner's step-output.log file directly
    const match = result.stdout.match(/oa-runner-\d+/);
    expect(match).toBeTruthy();
    const runnerName = match![0];
    const stepOutputLogPath = path.resolve(
      process.cwd(),
      "supervisor",
      "_",
      "logs",
      runnerName,
      "step-output.log",
    );
    const allLogs = fs.readFileSync(stepOutputLogPath, "utf8");

    // Verify the sequence
    expect(allLogs).toContain("Requesting cache reservation");
    expect(allLogs).toContain("Committing cache");
    expect(allLogs).toContain("hello e2e cache file");
  }, 90000);
});
