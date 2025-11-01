"use server";

import { db } from "@/db";
import { env } from "cloudflare:workers";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { DISCORD_CONVERSATION_PROMPT } from "./prompts";

export async function extractSubjectFromConversation(
  conversationSplitID: number
): Promise<{ success: boolean; subjectID?: number; error?: string }> {
  try {
    const conversationSplit = await db
      .selectFrom("conversation_splits")
      .selectAll()
      .where("id", "=", conversationSplitID)
      .executeTakeFirstOrThrow();

    const artifact = await db
      .selectFrom("artifacts")
      .selectAll()
      .where("id", "=", conversationSplit.artifactID)
      .executeTakeFirstOrThrow();

    const metadata = JSON.parse(conversationSplit.metadata || "{}");
    const bucketPath = metadata.bucketPath;

    if (!bucketPath) {
      return {
        success: false,
        error: "No bucketPath found in conversation split metadata",
      };
    }

    const conversationKey = `${bucketPath}conversation.md`;
    const conversationFile = await env.MACHINEN_BUCKET.get(conversationKey);

    if (!conversationFile) {
      return {
        success: false,
        error: `Conversation file not found at ${conversationKey}`,
      };
    }

    const conversationContent = await conversationFile.text();

    console.log("-".repeat(80));
    console.log(
      `Extracting subject from conversation split ${conversationSplitID}`
    );
    console.log(`Content length: ${conversationContent.length} characters`);
    console.log("-".repeat(80));

    const response = await generateText({
      model: openai("gpt-4o"),
      system: DISCORD_CONVERSATION_PROMPT,
      prompt: conversationContent,
      temperature: 0.1,
    });

    console.log("-".repeat(80));
    console.log("LLM Response:");
    console.log(response.text);
    console.log("-".repeat(80));

    const subjectData = JSON.parse(response.text);

    const subjectKey = `${bucketPath}subject.json`;
    await env.MACHINEN_BUCKET.put(subjectKey, response.text);

    const subject = await db
      .insertInto("subjects")
      .values({
        // @ts-ignore
        id: null,
        name: subjectData.subject.name,
        artifactID: artifact.id,
        bucketPath: artifact.bucketPath,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    console.log(`Created subject ${subject.id}: ${subject.name}`);

    return { success: true, subjectID: subject.id };
  } catch (error) {
    console.error("Error extracting subject from conversation:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function extractSubjectsFromAllSplits(
  artifactID?: number
): Promise<{
  processed: number;
  created: number;
  errors: string[];
}> {
  try {
    let conversationSplitsQuery = db
      .selectFrom("conversation_splits")
      .selectAll();

    if (artifactID) {
      conversationSplitsQuery = conversationSplitsQuery.where(
        "artifactID",
        "=",
        artifactID
      );
    }

    const conversationSplits = await conversationSplitsQuery.execute();

    const existingSubjects = await db
      .selectFrom("subjects")
      .select("artifactID")
      .distinct()
      .execute();

    const artifactsWithSubjects = new Set(
      existingSubjects.map((s) => s.artifactID)
    );

    const unprocessedSplits = conversationSplits.filter((split) => {
      return !artifactsWithSubjects.has(split.artifactID);
    });

    const errors: string[] = [];
    let processed = 0;
    let created = 0;

    for (const split of unprocessedSplits) {
      const result = await extractSubjectFromConversation(split.id);
      processed++;

      if (result.success) {
        created++;
      } else {
        errors.push(
          `Conversation split ${split.id}: ${result.error || "Unknown error"}`
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    return { processed, created, errors };
  } catch (error) {
    console.error("Error extracting subjects from splits:", error);
    return {
      processed: 0,
      created: 0,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}
