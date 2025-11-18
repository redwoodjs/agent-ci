const OPENAI_EMBEDDING_URL = "https://api.openai.com/v1/embeddings"
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small"

type OpenAiEmbeddingResponse = {
  data: Array<{
    embedding: number[]
  }>
}

export async function fetchOpenAiVectorString(
  text: string,
  apiKey?: string
): Promise<string> {
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("text must be a non-empty string")
  }

  const key = apiKey || process.env.OPENAI_API_KEY

  if (!key) {
    throw new Error("OPENAI_API_KEY is not set")
  }

  const response = await fetch(OPENAI_EMBEDDING_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: text,
      model: DEFAULT_EMBEDDING_MODEL,
    }),
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(`OpenAI embeddings request failed: ${message}`)
  }

  const payload = (await response.json()) as OpenAiEmbeddingResponse
  const embedding = payload.data?.[0]?.embedding

  if (!embedding || embedding.length === 0) {
    throw new Error("OpenAI embeddings response did not include an embedding")
  }

  return JSON.stringify(embedding)
}

