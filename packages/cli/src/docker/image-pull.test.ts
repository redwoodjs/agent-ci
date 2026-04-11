import { describe, it, expect, beforeAll } from "vitest";
import Docker from "dockerode";
import { ensureImagePulled } from "./image-pull.js";
import { resolveDockerSocket } from "./docker-socket.js";

// Integration test: requires a running Docker daemon and network access.
// Uses hello-world (~13 KB) to keep pull time minimal.
const TEST_IMAGE = "hello-world:latest";

describe("ensureImagePulled", () => {
  let docker: Docker;

  beforeAll(async () => {
    const socket = resolveDockerSocket();
    docker = new Docker({ socketPath: socket.socketPath });
    await docker.ping();
  });

  it("pulls the image when it is not present locally", { timeout: 60_000 }, async () => {
    // Arrange: remove the image so it is definitely absent
    try {
      await docker.getImage(TEST_IMAGE).remove({ force: true });
    } catch {
      // Already absent — fine
    }

    // Act
    await ensureImagePulled(docker, TEST_IMAGE);

    // Assert: image must now be inspectable
    const info = await docker.getImage(TEST_IMAGE).inspect();
    expect(info.RepoTags).toContain(TEST_IMAGE);
  });

  it(
    "rejects with an error when the image does not exist in the registry",
    { timeout: 30_000 },
    async () => {
      await expect(
        ensureImagePulled(docker, "ghcr.io/redwoodjs/agent-ci-does-not-exist:latest"),
      ).rejects.toThrow(
        "Failed to pull Docker image 'ghcr.io/redwoodjs/agent-ci-does-not-exist:latest'",
      );
    },
  );

  it("does nothing when the image is already present", async () => {
    // Arrange: ensure the image is present (previous test or pre-cached)
    await ensureImagePulled(docker, TEST_IMAGE);

    // Act: calling again must not throw
    await expect(ensureImagePulled(docker, TEST_IMAGE)).resolves.toBeUndefined();
  });
});
