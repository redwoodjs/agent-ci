export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface TokenBudget {
  maxTokens: number;
  reservedForResponse: number;
  reservedForPromptTemplate: number;
}

export function getAvailableInputTokens(budget: TokenBudget): number {
  return Math.max(
    0,
    budget.maxTokens -
      budget.reservedForResponse -
      budget.reservedForPromptTemplate
  );
}

export function createTokenBudget(
  maxTokens: number = 80000,
  reservedForResponse: number = 10000,
  reservedForPromptTemplate: number = 500
): TokenBudget {
  return {
    maxTokens,
    reservedForResponse,
    reservedForPromptTemplate,
  };
}

