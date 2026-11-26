import Anthropic from '@anthropic-ai/sdk';
import { LlmError, type FetchLike, type LlmProvider, type LlmRequest, type LlmResponse, type LlmToolCall } from '../types.js';

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxOutputTokens?: number;
  fetch?: FetchLike;
  baseURL?: string;
}

/**
 * Claude via the official SDK. Opus 5.5 rejects forced tool_choice, so tools are offered with
 * `tool_choice: auto` + `strict: true` and the system prompt instructs the model to call them.
 * Server-side refusal fallbacks are enabled (`fallbacks: "default"`).
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  readonly model: string;
  private readonly client: Anthropic;

  constructor(private readonly opts: AnthropicProviderOptions) {
    this.model = opts.model ?? 'claude-opus-5-5';
    this.client = new Anthropic({ apiKey: opts.apiKey, fetch: opts.fetch, baseURL: opts.baseURL, maxRetries: 2 });
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    try {
      const response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: req.maxOutputTokens ?? this.opts.maxOutputTokens ?? 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: this.opts.effort ?? 'medium' },
        system: req.system,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        ...(req.tools?.length
          ? {
              tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters, strict: true })),
              tool_choice: { type: 'auto' as const },
            }
          : {}),
      });

      if (response.stop_reason === 'refusal') {
        throw new LlmError('Model declined the request (refusal)', 'anthropic');
      }
      let text = '';
      const toolCalls: LlmToolCall[] = [];
      for (const block of response.content) {
        if (block.type === 'text') text += block.text;
        else if (block.type === 'tool_use') toolCalls.push({ name: block.name, arguments: block.input });
      }
      return {
        text,
        toolCalls,
        usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
        provider: 'anthropic',
        model: response.model ?? this.model,
        stopReason: response.stop_reason ?? undefined,
      };
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (err instanceof Anthropic.RateLimitError) throw new LlmError('Anthropic rate limit exceeded', 'anthropic', true);
      if (err instanceof Anthropic.APIConnectionError) throw new LlmError(`Anthropic connection error: ${err.message}`, 'anthropic', true);
      if (err instanceof Anthropic.APIError) {
        throw new LlmError(`Anthropic API error ${err.status ?? ''}: ${err.message}`, 'anthropic', (err.status ?? 0) >= 500);
      }
      throw err;
    }
  }
}
