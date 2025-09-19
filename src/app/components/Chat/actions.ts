import { createOpencodeClient } from "@opencode-ai/sdk/client";

// we will have to store these per-container;
// but I don't think they're expensive to open.
let CLIENT = new Map<string, ReturnType<typeof createOpencodeClient>>();

export function getClient({ containerId }: { containerId: string }) {
  if (!CLIENT.has(containerId)) {
    const baseUrl = `http://4096-${containerId}.localhost:5173`;
    console.log("baseUrl", baseUrl);

    const client = createOpencodeClient({
      baseUrl: `http://4096-${containerId}.localhost:5173`,
      responseStyle: "fields",
    });
    CLIENT.set(containerId, client);
  }
  return CLIENT.get(containerId)!;
}

export async function streamSessionMessages({
  containerId,
}: {
  containerId: string;
}) {
  const client = getClient({ containerId });

  const session = await getOrCreateSession({ containerId });

  const events = await client.event.subscribe();
  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        for await (const event of events.stream) {
          console.log("-".repeat(80));
          console.log(event);
          console.log("-".repeat(80));

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

export async function prompt({
  containerId,
  text,
}: {
  containerId: string;
  text: string;
}) {
  const { id: sessionId } = await getSession({ containerId });
  const client = getClient({ containerId });
  return await client.session.prompt({
    path: { id: sessionId },
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

export async function getSession({ containerId }: { containerId: string }) {
  const client = getClient({ containerId });
  const sessions = await client.session.list();
  const session = sessions.data?.find((s) => s.title === containerId);
  return session;
}

export async function getOrCreateSession({
  containerId,
}: {
  containerId: string;
}) {
  const session = await getSession({ containerId });
  if (session) {
    return session;
  } else {
    // do I also need to create a project?
    const client = getClient({ containerId });
    await client.session.create({
      body: {
        title: containerId,
      },
    });
  }
}
