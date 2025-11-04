"use server";

import { env } from "cloudflare:workers";
import { db } from "@/db";

export async function uploadFile(formData: FormData) {
  try {
    const file = formData.get("file") as File;
    const sourceID = formData.get("sourceID") as string;

    if (!file) {
      return { success: false, error: "No file provided" };
    }

    if (!sourceID) {
      return { success: false, error: "Source ID is required" };
    }

    const source = await db
      .selectFrom("sources")
      .selectAll()
      .where("id", "=", parseInt(sourceID))
      .executeTakeFirst();

    if (!source) {
      return { success: false, error: "Source not found" };
    }

    const bucketPrefix = source.bucket;
    const fileName = file.name;
    const fileKey = `${bucketPrefix}${fileName}`;

    await env.MACHINEN_BUCKET.put(fileKey, file.stream(), {
      httpMetadata: {
        contentType: file.type || "application/octet-stream",
      },
    });

    return {
      success: true,
      fileKey,
      fileName,
      size: file.size,
    };
  } catch (error) {
    console.error("Error uploading file:", error);
    return { success: false, error: "Failed to upload file" };
  }
}
