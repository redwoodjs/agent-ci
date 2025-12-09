import { env } from "cloudflare:workers";

export async function getEmbedding(text: string): Promise<number[]> {
  const modelId = "@cf/baai/bge-base-en-v1.5";
  const response = await (env.AI.run as any)(modelId, { text: [text] });
  if (response.data && response.data.length > 0) {
    return response.data[0];
  }
  throw new Error("Failed to generate embedding");
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
