/**
 * Cheap, provider-agnostic token estimate (~4 chars/token for English + code).
 * Used for budgeting before a call; billing uses the provider-reported usage.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
