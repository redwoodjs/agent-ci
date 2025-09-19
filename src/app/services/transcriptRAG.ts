"use server";

import { env } from "cloudflare:workers";

interface AutoRAGSearchResult {
  success: boolean;
  results?: {
    file_id: string;
    filename: string;
    score: number;
    content: { text: string }[];
    attributes: Record<string, any>;
  }[];
  answer?: string;
  error?: string;
}

/**
 * AutoRAG service for transcript search and retrieval
 * Uses Cloudflare Workers AI binding for native AutoRAG integration
 */
export class TranscriptRAGService {
  private autoragInstanceName: string;

  constructor(instanceName?: string) {
    this.autoragInstanceName = instanceName || 'machinen-transcripts';
  }

  /**
   * Note: AutoRAG instance creation is typically done via the Cloudflare dashboard
   * or CLI. This method provides status information only.
   */
  async getInstanceStatus(): Promise<{ success: boolean; status?: string; error?: string }> {
    try {
      // AutoRAG instances are managed via dashboard/CLI
      // This is a placeholder for status checking
      return {
        success: true,
        status: 'ready'
      };
    } catch (error) {
      console.error('Error getting instance status:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Search transcripts using semantic search via Workers AI binding
   */
  async searchTranscripts(query: string, containerId: string, options: {
    maxResults?: number;
    scoreThreshold?: number;
  } = {}): Promise<AutoRAGSearchResult> {
    try {
      const result = await env.AI.autorag(this.autoragInstanceName).search({
        query,
        max_num_results: options.maxResults || 10,
        ranking_options: {
          score_threshold: options.scoreThreshold || 0.3
        },
        filters: {
          folder: `${containerId}/`
        }
      });

      return {
        success: true,
        results: result.data || []
      };
    } catch (error) {
      console.error('Error searching transcripts:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Generate an AI response based on transcript content using Workers AI binding
   */
  async askQuestion(question: string, containerId: string, options: {
    model?: string;
    maxResults?: number;
    stream?: boolean;
  } = {}): Promise<{ success: boolean; answer?: string; sources?: any[]; error?: string }> {
    try {
      const result = await env.AI.autorag(this.autoragInstanceName).aiSearch({
        query: question,
        model: options.model || '@cf/meta/llama-3.1-8b-instruct',
        max_num_results: options.maxResults || 5,
        ranking_options: {
          score_threshold: 0.3
        },
        filters: {
          folder: `${containerId}/`
        },
        stream: options.stream || false
      });

      return {
        success: true,
        answer: result.response,
        sources: result.data || []
      };
    } catch (error) {
      console.error('Error asking question:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Test the AutoRAG instance connectivity
   */
  async testConnection(): Promise<{ success: boolean; message?: string; error?: string }> {
    try {
      // Simple test query to verify the instance is accessible
      const result = await env.AI.autorag(this.autoragInstanceName).search({
        query: 'test connection',
        max_num_results: 1
      });

      return {
        success: true,
        message: `Connected to AutoRAG instance: ${this.autoragInstanceName}`
      };
    } catch (error) {
      console.error('Error testing AutoRAG connection:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Connection failed'
      };
    }
  }
}

// Default service instance
export const transcriptRAG = new TranscriptRAGService();