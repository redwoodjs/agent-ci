import type { IndexingHookContext } from "../types";

function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length) {
    throw new Error("Vectors must have the same length");
  }
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function meanVector(vectors: number[][]): number[] {
  if (vectors.length === 0) {
    throw new Error("Cannot compute mean of empty vector array");
  }
  const dim = vectors[0].length;
  const mean = new Array(dim).fill(0);
  for (const vec of vectors) {
    if (vec.length !== dim) {
      throw new Error("All vectors must have the same dimension");
    }
    for (let i = 0; i < dim; i++) {
      mean[i] += vec[i];
    }
  }
  for (let i = 0; i < dim; i++) {
    mean[i] /= vectors.length;
  }
  return mean;
}

async function generateEmbeddingsBatch(
  texts: string[],
  env: IndexingHookContext["env"]
): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const response = (await env.AI.run("@cf/baai/bge-base-en-v1.5", {
    text: texts,
  })) as { data: number[][] };

  if (
    !response ||
    !Array.isArray(response.data) ||
    response.data.length !== texts.length
  ) {
    throw new Error("Failed to generate batch embeddings");
  }

  return response.data;
}

export async function summarizeNumerically(
  texts: string[],
  env: IndexingHookContext["env"]
): Promise<string> {
  if (!texts || texts.length === 0) {
    return "";
  }

  if (texts.length === 1) {
    return texts[0];
  }

  console.log(
    `[vector-summary] Computing vector compression for ${texts.length} texts`
  );

  const embeddings = await generateEmbeddingsBatch(texts, env);
  const meanEmbedding = meanVector(embeddings);

  let bestIndex = 0;
  let bestSimilarity = cosineSimilarity(embeddings[0], meanEmbedding);

  for (let i = 1; i < embeddings.length; i++) {
    const similarity = cosineSimilarity(embeddings[i], meanEmbedding);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestIndex = i;
    }
  }

  console.log(
    `[vector-summary] Selected text ${bestIndex + 1}/${texts.length} as most representative (similarity: ${bestSimilarity.toFixed(4)})`
  );

  return texts[bestIndex];
}
