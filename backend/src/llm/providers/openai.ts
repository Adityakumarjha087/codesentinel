import OpenAI from 'openai';
import { LlmError, parseToolArguments, type FetchLike, type LlmProvider, type LlmRequest, type LlmResponse } from '../types.js';

export interface OpenAiProviderOptions {
  apiKey: string;
  model?: string;
  baseURL?: string;
  maxOutputTokens?: number;
  fetch?: FetchLike;
}

export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai' as const;
  readonly model: string;
  private readonly client: OpenAI;

  constructor(private readonly opts: OpenAiProviderOptions) {
    this.model = opts.model ?? 'gpt-4.1';
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL, fetch: opts.fetch, maxRetries: 2 });
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    try {
      const res = await this.client.chat.completions.create({
        model: this.model,
        max_completion_tokens: req.maxOutputTokens ?? this.opts.maxOutputTokens ?? 4096,
        messages: [{ role: 'system', content: req.system }, ...req.messages.map((m) => ({ role: m.role, content: m.content }))],
        ...(req.tools?.length
          ? {
              tools: req.tools.map((t) => ({
                type: 'function' as const,
                function: { name: t.name, description: t.description, parameters: t.parameters, strict: true },
              })),
              tool_choice: 'required' as const,
            }
          : {}),
      });
      const choice = res.choices[0];
      const toolCalls = (choice?.message.tool_calls ?? []).flatMap((c) =>
        c.type === 'function' ? [{ name: c.function.name, arguments: parseToolArguments(c.function.arguments) }] : [],
      );
      return {
        text: choice?.message.content ?? '',
        toolCalls,
        usage: { inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: res.usage?.completion_tokens ?? 0 },
        provider: 'openai',
        model: res.model ?? this.model,
        stopReason: choice?.finish_reason ?? undefined,
      };
    } catch (err) {
      if (err instanceof OpenAI.APIError) {
        throw new LlmError(`OpenAI API error ${err.status ?? ''}: ${err.message}`, 'openai', err.status === 429 || (err.status ?? 0) >= 500);
      }
      throw err;
    }
  }
}
