import { createOpencodeClient } from "@opencode-ai/sdk/client";

// we will have to store these per-container;
// but I don't think they're expensive to open.
let CLIENT: ReturnType<typeof createOpencodeClient> | null = null;

export function getClient() {
  if (!CLIENT) {
    CLIENT = createOpencodeClient({
      baseUrl: "http://localhost:4096",
      responseStyle: "fields",
    });
  }
  return CLIENT;
}

export async function streamSessionMessages(sessionID: string) {
  const client = getClient();
  const events = await client.event.subscribe();
  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        for await (const event of events.stream) {
          // TODO(peterp, 2025-09-18): Filter by `sessionID`
          if (event.type === "message.part.updated") {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify(event.properties?.part)}\n\n`
              )
            );
          }
        }
      } catch (error) {
        console.error("Error processing events:", error);
        controller.error(error);
      } finally {
        controller.close();
      }
    },
  });
}

export async function prompt(sessionID: string, text: string) {
  const client = getClient();
  return await client.session.prompt({
    path: { id: sessionID },
    body: {
      parts: [
        {
          type: "text",
          text,
        },
      ],
    },
  });
}
