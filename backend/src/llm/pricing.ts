/** USD per 1M tokens. Keep in sync with provider price pages; unknown models fall back to `default`. */
export interface ModelPrice {
  input: number;
  output: number;
}

export const MODEL_PRICING: Record<string, ModelPrice> = {
  // Simulated price for the offline mock so dashboards show realistic cost curves.
  'codesentinel-mock-1': { input: 0.25, output: 1.25 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  default: { input: 1, output: 5 },
};

export function priceFor(provider: string, model: string): ModelPrice {
  if (provider === 'ollama') return { input: 0, output: 0 };
  return MODEL_PRICING[model] ?? MODEL_PRICING.default!;
}

export function costUsd(provider: string, model: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(provider, model);
  return Number(((inputTokens * p.input + outputTokens * p.output) / 1_000_000).toFixed(6));
}
