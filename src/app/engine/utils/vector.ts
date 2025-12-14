import { env } from "cloudflare:workers";

export async function getEmbedding(text: string): Promise<number[]> {
  const modelId = "@cf/baai/bge-base-en-v1.5";
  const embeddings = await getEmbeddings([text]);
  if (embeddings.length !== 1) {
    throw new Error("Failed to generate embedding");
  }
  return embeddings[0];
}

export async function getEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }
  const modelId = "@cf/baai/bge-base-en-v1.5";
  const response = await (env.AI.run as any)(modelId, { text: texts });
  if (response?.data && Array.isArray(response.data)) {
    return response.data as number[][];
  }
  throw new Error("Failed to generate embeddings");
}

export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length) {
    throw new Error("Vectors must be of the same length");
  }

  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    magnitudeA += vecA[i] * vecA[i];
    magnitudeB += vecB[i] * vecB[i];
  }

  magnitudeA = Math.sqrt(magnitudeA);
  magnitudeB = Math.sqrt(magnitudeB);

  if (magnitudeA === 0 || magnitudeB === 0) {
    return 0;
  }

  return dotProduct / (magnitudeA * magnitudeB);
}
