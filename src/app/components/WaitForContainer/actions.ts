"use server";

import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";
import { getProjectInfo } from "@/app/services/project";

async function streamToString(
  stream: ReadableStream<Uint8Array>
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  // Combine all chunks and decode to string
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(combined);
}

export async function isContainerReady(containerId: string) {
  const sandbox = getSandbox(env.Sandbox, containerId);
  const p = await sandbox.getExposedPorts("localhost");
  return p.length > 0;
}

export async function startContainer({ containerId }: { containerId: string }) {
  const { repository, runOnBoot, processCommand } = await getProjectInfo(
    containerId
  );

  const sandbox = getSandbox(env.Sandbox, containerId);
  await sandbox.start({
    enableInternet: true,
  });

  let { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const [clientReadable, logReadable] = readable.tee();
  let writer = writable.getWriter();

  // Run all operations asynchronously and properly close the stream
  (async () => {
    try {
      if (repository) {
        const result = await sandbox.gitCheckout(repository, {
          targetDir: "/workspace",
        });

        await writer.write(new TextEncoder().encode(result.stdout));
        await writer.write(new TextEncoder().encode(result.stderr));
        await writer.write(
          new TextEncoder().encode(`Exit code: ${result.exitCode.toString()}`)
        );
      } else {
        const stream = await sandbox.execStream(
          "cd / && mkdir -p /workspace && cp -R /redwoodsdk/minimal/* /workspace",
          {
            cwd: "/",
            sessionId: "runOnBoot",
          }
        );
        const reader = stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await writer.write(value);
          }
        } finally {
          reader.releaseLock();
        }
      }

      if (runOnBoot.length) {
        for (const command of runOnBoot) {
          const stream = await sandbox.execStream(command.trim(), {
            cwd: "/workspace",
            sessionId: "runOnBoot",
          });
          const reader = stream.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              await writer.write(value);
            }
          } finally {
            reader.releaseLock();
          }
        }
      }

      if (processCommand) {
        await sandbox.startProcess(processCommand, {
          cwd: "/workspace",
        });
      }

      // TODO: This is supplied by the user.
      await sandbox.exposePort(5173, { hostname: "localhost:5173" });
      console.log("writing container initialization complete"),
        await writer.write(
          new TextEncoder().encode("Container initialization complete")
        );
    } catch (error) {
      console.log("error", error);
      await writer.write(
        new TextEncoder().encode(`Error: ${(error as Error)?.message || error}`)
      );
    } finally {
      console.log("closing writer");
      await writer.close();

      // Convert the log stream to a string
      const contents = await streamToString(logReadable);
      await sandbox.writeFile("/tmp/boot.log", contents);
    }
  })();

  return clientReadable;
}
