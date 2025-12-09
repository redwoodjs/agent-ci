import { callLLM } from "./llm";

export async function generateTitleForText(text: string): Promise<string> {
  // Use a substring to stay within reasonable limits for a title summary
  const truncatedText = text.substring(0, 2000);
  console.log(
    `[summarize] Generating title for text length: ${text.length} (truncated to 2000)`
  );

  try {
    const titlePrompt = `Analyze the following text from a document and generate a short, concise title (less than 10 words) that summarizes its core subject. The title should be descriptive and suitable for a user to understand the topic at a glance. Examples: "Bug: User login fails", "Feature: Add dark mode", "Refactor: API authentication". Do not include quotes in the title. Text: "${truncatedText}"`;

    const titleResponse = await callLLM(titlePrompt, "gpt-oss-20b-cheap");

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
