import type { Env } from '../config/env.js';
import { MockLlmProvider } from './mock/provider.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { GeminiProvider } from './providers/gemini.js';
import { OllamaProvider } from './providers/ollama.js';
import { OpenAiProvider } from './providers/openai.js';
import type { FetchLike, LlmProvider } from './types.js';

export * from './types.js';

type LlmEnv = Pick<
  Env,
  'LLM_PROVIDER' | 'LLM_MODEL' | 'LLM_MAX_OUTPUT_TOKENS' | 'OPENAI_API_KEY' | 'OPENAI_BASE_URL' | 'ANTHROPIC_API_KEY' | 'ANTHROPIC_EFFORT' | 'GEMINI_API_KEY' | 'OLLAMA_BASE_URL'
>;

/** Select the LLM provider from env. Everything downstream depends only on `LlmProvider`. */
export function createLlmProvider(env: LlmEnv, fetchImpl?: FetchLike): LlmProvider {
  const maxOutputTokens = env.LLM_MAX_OUTPUT_TOKENS;
  switch (env.LLM_PROVIDER) {
    case 'anthropic':
      return new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY ?? '', model: env.LLM_MODEL, effort: env.ANTHROPIC_EFFORT, maxOutputTokens, fetch: fetchImpl });
    case 'openai':
      return new OpenAiProvider({ apiKey: env.OPENAI_API_KEY ?? '', model: env.LLM_MODEL, baseURL: env.OPENAI_BASE_URL, maxOutputTokens, fetch: fetchImpl });
    case 'gemini':
      return new GeminiProvider({ apiKey: env.GEMINI_API_KEY ?? '', model: env.LLM_MODEL, maxOutputTokens, fetch: fetchImpl });
    case 'ollama':
      return new OllamaProvider({ baseUrl: env.OLLAMA_BASE_URL, model: env.LLM_MODEL, maxOutputTokens, fetch: fetchImpl });
    case 'mock':
    default:
      return new MockLlmProvider();
  }
}
