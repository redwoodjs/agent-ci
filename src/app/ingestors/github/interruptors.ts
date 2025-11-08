import { type RequestInfo } from "rwsdk/worker";
import { env } from "cloudflare:workers";

declare module "rwsdk/worker" {
  interface WorkerEnv {
    INGEST_API_KEY?: string;
  }
}

function arrayBufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function verifySignature(
  secret: string,
  body: string,
  signature: string
) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const expectedSignatureHex = arrayBufferToHex(signed);
  const expectedSignature = `sha256=${expectedSignatureHex}`;

  const sigHex = signature.startsWith("sha256=") ? signature.substring(7) : "";
  const expectedSigHex = expectedSignature.substring(7);

  return constantTimeEqual(sigHex.toLowerCase(), expectedSigHex.toLowerCase());
}

export async function requireGitHubWebhookSignature({ request }: RequestInfo) {
  const signature = request.headers.get("X-Hub-Signature-256");

  if (!signature) {
    return new Response("Missing signature", { status: 401 });
  }

  const webhookSecret = (env as any).INGEST_API_KEY as string | undefined;
  if (!webhookSecret) {
    console.error("INGEST_API_KEY is not set");
    return new Response("Server configuration error", { status: 500 });
  }

  const body = await request.clone().text();
  const isValid = await verifySignature(webhookSecret, body, signature);

  if (!isValid) {
    return new Response("Invalid signature", { status: 401 });
  }
}
