"use server";

import { db } from "@/db";

export async function createSource(formData: FormData) {
  try {
    const name = formData.get("name") as string;
    const type = formData.get("type") as string;
    const url = formData.get("url") as string | null;
    const description = formData.get("description") as string;
    const bucket = formData.get("bucket") as string;

    if (!name || !type || !description) {
      return { success: false, error: "Missing required fields" };
    }

    const result = await db
      .insertInto("sources")
      .values({
        name,
        type,
        url: url || null,
        description,
        bucket: bucket || "default",
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return { success: true, sourceId: result.id };
  } catch (error) {
    console.error("Error creating source:", error);
    return { success: false, error: "Failed to create source" };
  }
}

