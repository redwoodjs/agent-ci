import { env } from "cloudflare:workers";

type ContextFilename =
  | "overview.md"
  | "subtasks.md"
  | "transcript.json"
  | "enhanced_overview.md"
  | "enhanced_subtasks.md"
  | "enhanced_transcript.json";

export function getBucketLocation({
  containerId,
  filename,
}: {
  containerId: string;
  filename: ContextFilename;
}) {
  return `${containerId}/${filename}`;
}

export async function getContextFile(
  containerId: string,
  filename: ContextFilename
) {
  const f = await env.CONTEXT_STREAM.get(
    getBucketLocation({ containerId, filename })
  );
  if (f) {
    return f.text();
  } else {
    return "";
  }
}

export async function setContextFile(
  containerId: string,
  filename: ContextFilename,
  content: string
) {
  await env.CONTEXT_STREAM.put(
    getBucketLocation({ containerId, filename }),
    content
  );
}
