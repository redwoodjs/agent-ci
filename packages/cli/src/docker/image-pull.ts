import type Docker from "dockerode";

// Dedup concurrent pulls of the same image. Without this, `--all` runs racing
// to pull the same runner image trigger N concurrent `docker pull` requests
// for the same tag. See issue #211.
const inflightPulls = new Map<string, Promise<void>>();

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

  const existing = inflightPulls.get(image);
  if (existing) {
    return existing;
  }

  const pull = new Promise<void>((resolve, reject) => {
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
  }).finally(() => {
    inflightPulls.delete(image);
  });

  inflightPulls.set(image, pull);
  return pull;
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
