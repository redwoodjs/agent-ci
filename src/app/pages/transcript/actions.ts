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
    const objectKey = `${containerId}/${transcript.id}.json`;

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
    // List objects with the container prefix
    const listResult = await env.CONTEXT_STREAM.list({
      prefix: `${containerId}/`,
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
    const objectKey = `${containerId}/${transcriptId}.json`;

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

export async function generateTranscriptsFromGitHistory(containerId: string) {
  try {
    const { execSync } = require("child_process");
    
    // Get commit history
    const commitData = execSync(
      'git log --pretty=format:"%H|%an|%ae|%ad|%s|%b" --date=iso -30',
      { encoding: 'utf-8' }
    );

    // Import the generator functions
    const { parseCommitHistory, generateTranscriptFromCommits } = await import("./generate-transcripts");
    
    const commits = parseCommitHistory(commitData);
    const transcripts = generateTranscriptFromCommits(commits, containerId);
    
    // Save each transcript to R2
    const savedTranscripts = [];
    for (const transcript of transcripts) {
      const saveResult = await saveTranscriptToR2(containerId, transcript);
      if (saveResult.success) {
        savedTranscripts.push(transcript);
      }
    }

    console.log("Generated transcripts from git history:", {
      containerId,
      transcriptCount: savedTranscripts.length,
    });

    return {
      success: true,
      transcripts: savedTranscripts,
      message: `Generated ${savedTranscripts.length} transcripts from git history`,
    };
  } catch (error) {
    console.error("Failed to generate transcripts from git history:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
      transcripts: [],
    };
  }
}

export async function initializeTranscriptRAG(containerId: string) {
  try {
    const { transcriptRAG } = await import("@/app/services/transcriptRAG");
    
    // Test connection to AutoRAG instance
    const connectionResult = await transcriptRAG.testConnection();
    
    if (!connectionResult.success) {
      return {
        success: false,
        error: `AutoRAG connection failed: ${connectionResult.error}`,
        message: "Make sure your AutoRAG instance 'machinen-transcripts' exists in Cloudflare dashboard"
      };
    }

    return {
      success: true,
      message: "AutoRAG connection verified - ready for search!",
    };
  } catch (error) {
    console.error("Failed to initialize transcript RAG:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export async function searchTranscripts(query: string, containerId: string) {
  try {
    const { transcriptRAG } = await import("@/app/services/transcriptRAG");
    
    const result = await transcriptRAG.searchTranscripts(query, containerId, {
      maxResults: 10,
      scoreThreshold: 0.3
    });
    
    if (!result.success) {
      return {
        success: false,
        error: result.error,
        results: [],
      };
    }

    // Transform the results to match our interface
    const transformedResults = result.results?.map(item => ({
      id: item.file_id,
      score: item.score,
      content: item.content.map(c => c.text).join(' '),
      metadata: item.attributes
    })) || [];

    return {
      success: true,
      results: transformedResults,
      message: `Found ${transformedResults.length} relevant transcript segments`,
    };
  } catch (error) {
    console.error("Failed to search transcripts:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
      results: [],
    };
  }
}

export async function askTranscriptQuestion(question: string, containerId: string) {
  try {
    const { transcriptRAG } = await import("@/app/services/transcriptRAG");
    
    const result = await transcriptRAG.askQuestion(question, containerId);
    
    if (!result.success) {
      return {
        success: false,
        error: result.error,
      };
    }

    return {
      success: true,
      answer: result.answer,
      sources: result.sources,
      message: "Generated answer from transcript knowledge base",
    };
  } catch (error) {
    console.error("Failed to ask transcript question:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export async function getRAGStatus(containerId: string) {
  try {
    const { transcriptRAG } = await import("@/app/services/transcriptRAG");
    
    const result = await transcriptRAG.getInstanceStatus();
    
    return {
      success: true,
      status: result.status,
      error: result.error,
    };
  } catch (error) {
    console.error("Failed to get RAG status:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
