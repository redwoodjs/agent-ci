// Rubric scorer: regex checks over streams extracted from the transcript.

export function score(rubric, streams) {
  const results = [];
  for (const item of rubric) {
    const haystack = streamText(streams, item.stream);
    const re = new RegExp(item.pattern, item.flags ?? "i");
    const found = re.test(haystack);
    const pass = item.must === "present" ? found : !found;
    results.push({ id: item.id, pass, found, must: item.must, pattern: item.pattern });
  }
  return results;
}

function streamText(streams, which) {
  if (which === "tool_calls") {
    return streams.toolCalls.map((c) => `${c.name} ${c.flat}`).join("\n");
  }
  if (which === "file_edits") {
    return streams.fileEdits.map((e) => `${e.path}\n${e.content}`).join("\n---\n");
  }
  if (which === "text") {
    return streams.text.join("\n");
  }
  throw new Error(`unknown stream: ${which}`);
}
