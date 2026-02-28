import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "./index.js";

describe("Supervisor Server API", () => {
  it("GET /status returns Idle by default", async () => {
    const res = await request(app.handler as any).get("/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "Idle",
      activeContainers: [],
      recentJobs: [],
    });
  });

  it("POST /repos adds a repo and GET /repos returns it", async () => {
    const testPath = "/Users/test/mock-repo";
    const res1 = await request(app.handler as any)
      .post("/repos")
      .send({ repoPath: testPath });
    expect(res1.status).toBe(200);

    const res2 = await request(app.handler as any).get("/repos");
    expect(res2.status).toBe(200);
    expect(Array.isArray(res2.body)).toBe(true);
    expect(res2.body.includes(testPath)).toBe(true);

    // Cleanup
    await request(app.handler as any)
      .delete("/repos")
      .send({ repoPath: testPath });
  });

  it("POST /repos/watched enables watching and GET /repos/watched returns it", async () => {
    const testPath = "/Users/test/mock-repo-watched";
    const res1 = await request(app.handler as any)
      .post("/repos/watched")
      .send({ repoPath: testPath });
    expect(res1.status).toBe(200);

    const res2 = await request(app.handler as any).get("/repos/watched");
    expect(res2.status).toBe(200);
    expect(Array.isArray(res2.body)).toBe(true);
    expect(res2.body.includes(testPath)).toBe(true);

    // Cleanup
    await request(app.handler as any)
      .delete("/repos/watched")
      .send({ repoPath: testPath });
  });

  it("GET /workflows fails without repoPath", async () => {
    const res = await request(app.handler as any).get("/workflows");
    expect(res.status).toBe(400);
  });
});
