import type Docker from "dockerode";

/**
 * Ensures a Docker image is present locally, pulling it if not.
 *
 * Docker's createContainer() returns a 404 "No such image" error when the
 * image is absent — it does not pull automatically. This helper mirrors the
 * pattern already used by service-containers.ts and must be called before
 * any createContainer() call.
 *
 * Reproduces: https://github.com/redwoodjs/agent-ci/issues/203
 */
export async function ensureImagePulled(docker: Docker, image: string): Promise<void> {
  try {
    await docker.getImage(image).inspect();
    return; // already present
  } catch {
    // Not found locally — fall through to pull
  }

  await new Promise<void>((resolve, reject) => {
    docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) {
        return reject(wrapPullError(image, err));
      }
      docker.modem.followProgress(stream, (err: Error | null) => {
        if (err) {
          reject(wrapPullError(image, err));
        } else {
          resolve();
        }
      });
    });
  });
}

function wrapPullError(image: string, cause: Error): Error {
  return new Error(
    `Failed to pull Docker image '${image}': ${cause.message}\n` +
      "\n" +
      "  Possible causes:\n" +
      "    • The image name is misspelled or does not exist in the registry\n" +
      "    • The image is private — authenticate first: docker login <registry>\n" +
      "    • No network connection",
  );
}
