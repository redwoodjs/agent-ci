import test from "node:test";
import assert from "node:assert/strict";

const BASE_URL = process.env.MACHINEN_BASE_URL ?? "http://localhost:5173";
const API_KEY = process.env.MACHINEN_API_KEY ?? "";

test("ui smoke: audit simulation runs page (click + dom)", async (t) => {
  if (!API_KEY) {
    t.skip("Missing MACHINEN_API_KEY");
    return;
  }

  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    t.skip("Missing playwright dependency");
    return;
  }

  const { chromium } = playwright;

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (
      msg.includes("Executable doesn't exist") ||
      msg.includes("browserType.launch") ||
      msg.includes("Failed to launch")
    ) {
      t.skip(
        "Playwright browser not installed. Run: pnpm -s playwright:install"
      );
      return;
    }
    throw e;
  }

  const context = await browser.newContext({
    httpCredentials: {
      username: "admin",
      password: API_KEY,
    },
  });
  const page = await context.newPage();

  try {
    await page.goto(`${BASE_URL}/audit/simulation`, {
      waitUntil: "networkidle",
    });

    await page.waitForSelector("text=Simulation runs");

    await page.getByRole("button", { name: "Start run" }).click();

    await page.waitForURL(/\/audit\/simulation\?runId=/);

    const url = new URL(page.url());
    const runId = url.searchParams.get("runId");
    assert.ok(runId);

    await page.waitForSelector("text=Run");

    // Advance from ingest_diff to micro_batches
    await page.getByRole("button", { name: "Advance" }).click();
    
    // Polling for UI update since advancement is async
    await page.waitForFunction(
        () => document.body.innerText.includes("micro_batches"),
        { timeout: 30000 }
    );

    // Advance from micro_batches to macro_synthesis
    await page.getByRole("button", { name: "Advance" }).click();
    await page.waitForFunction(
        () => document.body.innerText.includes("macro_synthesis"),
        { timeout: 30000 }
    );

    const eventsText = await page.locator("textarea").first().inputValue();
    assert.ok(eventsText.includes("phase.start"));
    assert.ok(eventsText.includes("phase.end"));
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});
