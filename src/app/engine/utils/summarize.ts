import { callLLM } from "./llm";

export async function generateTitleForText(text: string): Promise<string> {
  // Use a substring to stay within reasonable limits for a title summary
  const truncatedText = text.substring(0, 2000);
  console.log(
    `[summarize] Generating title for text length: ${text.length} (truncated to 2000)`
  );

  try {
    const titlePrompt = `Analyze the following text which describes a series of events. Generate a short, concise title (less than 10 words) that describes what happened in the past tense. The title should read like an event or a milestone in a timeline. Examples: "User login bug was fixed", "Dark mode feature was added", "API authentication was refactored". Do not include quotes in the title. Text: "${truncatedText}"`;

    const titleResponse = await callLLM(titlePrompt, "llama-3-1-8b");

    if (!titleResponse || typeof titleResponse !== "string") {
      const errorMsg =
        "[summarize] AI returned empty or invalid response for title generation";
      console.error(errorMsg);
      throw new Error(errorMsg);
    }

    const newTitle = titleResponse.trim().replace(/"/g, "");
    if (!newTitle) {
      const errorMsg = "[summarize] AI generated empty title string";
      console.error(errorMsg);
      throw new Error(errorMsg);
    }

    return newTitle;
  } catch (error) {
    console.error("[summarize] Error generating subject title:", error);
    // Explode violently on failure as requested.
    throw error;
  }
}
