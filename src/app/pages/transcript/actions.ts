"use server";

import { env } from "cloudflare:workers";

interface TranscriptEntry {
  id: string;
  timestamp: string;
  speaker: string;
  text: string;
  confidence: number;
}

interface Transcript {
  id: string;
  meetingId: string;
  title: string;
  createdAt: string;
  duration: number;
  participants: string[];
  entries: TranscriptEntry[];
}

export async function saveTranscriptToR2(
  containerId: string,
  transcript: Transcript
) {
  try {
    const bucketPrefix = `${containerId}/transcripts`;
    const objectKey = `${bucketPrefix}/${transcript.id}.json`;

    // Add metadata to the transcript
    const transcriptWithMetadata = {
      ...transcript,
      containerId,
      savedAt: new Date().toISOString(),
      version: 1,
    };

    const result = await env.CONTEXT_STREAM.put(
      objectKey,
      JSON.stringify(transcriptWithMetadata, null, 2),
      {
        httpMetadata: {
          contentType: "application/json",
        },
        customMetadata: {
          containerId,
          meetingId: transcript.meetingId,
          title: transcript.title,
          participants: transcript.participants.join(","),
          entryCount: transcript.entries.length.toString(),
          savedAt: transcriptWithMetadata.savedAt,
        },
      }
    );

    console.log("Transcript saved to R2:", {
      objectKey,
      containerId,
      meetingId: transcript.meetingId,
      result,
    });

    return {
      success: true,
      objectKey,
      message: "Transcript saved successfully",
    };
  } catch (error) {
    console.error("Failed to save transcript to R2:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export async function getTranscriptsFromR2(containerId: string) {
  try {
    const bucketPrefix = `${containerId}/transcripts`;

    // List objects with the transcript prefix
    const listResult = await env.CONTEXT_STREAM.list({
      prefix: bucketPrefix,
    });

    const transcripts: Transcript[] = [];

    for (const object of listResult.objects) {
      if (object.key.endsWith(".json")) {
        try {
          const transcriptObj = await env.CONTEXT_STREAM.get(object.key);
          if (transcriptObj) {
            const transcript = (await transcriptObj.json()) as Transcript;
            transcripts.push(transcript);
          }
        } catch (error) {
          console.error(`Failed to parse transcript ${object.key}:`, error);
        }
      }
    }

    // Sort by creation date (newest first)
    transcripts.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    return {
      success: true,
      transcripts,
    };
  } catch (error) {
    console.error("Failed to get transcripts from R2:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
      transcripts: [],
    };
  }
}

export async function deleteTranscriptFromR2(
  containerId: string,
  transcriptId: string
) {
  try {
    const bucketPrefix = `${containerId}/transcripts`;
    const objectKey = `${bucketPrefix}/${transcriptId}.json`;

    const result = await env.CONTEXT_STREAM.delete(objectKey);

    console.log("Transcript deleted from R2:", {
      objectKey,
      containerId,
      transcriptId,
      result,
    });

    return {
      success: true,
      objectKey,
      message: "Transcript deleted successfully",
    };
  } catch (error) {
    console.error("Failed to delete transcript from R2:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
