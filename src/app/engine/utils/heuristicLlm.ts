import type { LLMAlias } from "./llm";

export async function getHeuristicResponse(prompt: string, alias: LLMAlias): Promise<string> {
  // 1. Detect if it's a micro-moment summarization prompt
  if (prompt.includes("Return a list of short summaries of what was discussed")) {
    return generateHeuristicMicroSummaries(prompt);
  }

  // 2. Detect if it's a macro-moment classification prompt
  if (prompt.includes("You are classifying macro moments in a timeline")) {
    return generateHeuristicMacroClassification(prompt);
  }

  // Default fallback
  return "H1|Heuristic approximation: Content processed without AI analysis.";
}

function generateHeuristicMicroSummaries(prompt: string): string {
  // Extract chunks section
  const chunksMatch = prompt.match(/CHUNKS:\n([\s\S]+)\n\nOUTPUT:/);
  if (!chunksMatch) return "S1|No chunks found in prompt context.";

  const chunkBlock = chunksMatch[1];
  const chunks = chunkBlock.split("\n\n---\n\n");

  const highSignalVerbs = ["propose", "suggest", "fix", "decide", "implement", "error", "bug", "crash", "stalled", "added", "removed", "changed"];
  const out: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const headerMatch = chunk.match(/CHUNK \d+ \(type=([^,]+), author=([^)]+)\):/);
    const author = headerMatch?.[2] ?? "unknown";
    const content = chunk.replace(/CHUNK \d+ \(type=[^,]+, author=[^)]+\):\n/, "").trim();

    // Heuristic: Extract the first sentence that contains a high-signal verb, or just the first sentence.
    const sentences = content.split(/[.!?]\s+/);
    let bestSentence = "";

    for (const s of sentences) {
      const lowerS = s.toLowerCase();
      if (highSignalVerbs.some(v => lowerS.includes(v))) {
        bestSentence = s.trim();
        break;
      }
    }

    if (!bestSentence && sentences.length > 0) {
      bestSentence = sentences[0].trim();
    }

    if (bestSentence) {
      // Ensure attribution
      let summary = bestSentence;
      if (!summary.toLowerCase().includes(author.toLowerCase()) && author !== "unknown") {
        summary = `${author} noted: ${summary}`;
      }
      
      // Truncate to 400 chars as per prompt rules
      if (summary.length > 400) {
        summary = summary.substring(0, 397) + "...";
      }

      out.push(`S${out.length + 1}|${summary}`);
    }

    if (out.length >= 12) break;
  }

  return out.length > 0 ? out.join("\n") : "S1|Heuristic summary: No clear signal found in chunks.";
}

function generateHeuristicMacroClassification(prompt: string): string {
  // Extract moments from "Macro moments:" section
  const momentsMatch = prompt.match(/Macro moments:\n([\s\S]+)$/);
  if (!momentsMatch) return "[]";

  const momentsBlock = momentsMatch[1];
  const momentEntries = momentsBlock.split("\n---\n\n");

  const results: any[] = [];

  for (const entry of momentEntries) {
    const lines = entry.trim().split("\n");
    const indexMatch = lines[0]?.match(/Index: (\d+)/);
    const titleLine = lines.find(l => l.startsWith("Title: "))?.replace("Title: ", "") ?? "";
    const summaryLine = lines.find(l => l.startsWith("Summary: "))?.replace("Summary: ", "") ?? "";

    if (!indexMatch) continue;

    const index = parseInt(indexMatch[1], 10);
    const fullText = (titleLine + " " + summaryLine).toLowerCase();

    let momentKind: string = "attempt";
    let isSubject = false;
    let subjectKind: string | null = null;
    let subjectReason: string | null = null;

    if (fullText.includes("merged") || fullText.includes("completed") || fullText.includes("resolved") || fullText.includes("solved")) {
      momentKind = "solution";
    } else if (fullText.includes("decided") || fullText.includes("choose") || fullText.includes("selected")) {
      momentKind = "decision";
    } else if (fullText.includes("error") || fullText.includes("bug") || fullText.includes("stalled") || fullText.includes("failed") || fullText.includes("problem")) {
      momentKind = "problem";
      isSubject = true;
      subjectKind = "problem";
      subjectReason = "Automatic heuristic detection of a critical failure or blocker.";
    } else if (fullText.includes("challenge") || fullText.includes("difficulty")) {
      momentKind = "challenge";
      isSubject = true;
      subjectKind = "challenge";
      subjectReason = "Detected a technical challenge requiring attention.";
    }

    results.push({
      index,
      momentKind,
      isSubject,
      subjectKind,
      subjectReason,
      subjectEvidence: isSubject ? [titleLine.substring(0, 50)] : [],
      momentEvidence: [titleLine.substring(0, 50)],
      confidence: "medium"
    });
  }

  return JSON.stringify(results);
}
