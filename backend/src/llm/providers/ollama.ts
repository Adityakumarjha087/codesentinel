import { LlmError, parseToolArguments, type FetchLike, type LlmProvider, type LlmRequest, type LlmResponse } from '../types.js';

export interface OllamaProviderOptions {
  baseUrl: string;
  model?: string;
  maxOutputTokens?: number;
  fetch?: FetchLike;
}

interface OllamaChatResponse {
  model?: string;
  message?: { content?: string; tool_calls?: { function: { name: string; arguments: unknown } }[] };
  prompt_eval_count?: number;
  eval_count?: number;
  done_reason?: string;
}

/** Local models through Ollama's /api/chat endpoint (supports tool calling on capable models). */
export class OllamaProvider implements LlmProvider {
  readonly name = 'ollama' as const;
  readonly model: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly opts: OllamaProviderOptions) {
    this.model = opts.model ?? 'qwen2.5-coder:7b';
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        options: { num_predict: req.maxOutputTokens ?? this.opts.maxOutputTokens ?? 4096, temperature: 0 },
        messages: [{ role: 'system', content: req.system }, ...req.messages],
        ...(req.tools?.length
          ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) }
          : {}),
      }),
    });
    if (!res.ok) throw new LlmError(`Ollama error ${res.status}: ${await res.text()}`, 'ollama', res.status >= 500);
    const data = (await res.json()) as OllamaChatResponse;
    return {
      text: data.message?.content ?? '',
      toolCalls: (data.message?.tool_calls ?? []).map((c) => ({ name: c.function.name, arguments: parseToolArguments(c.function.arguments) })),
      usage: { inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0 },
      provider: 'ollama',
      model: data.model ?? this.model,
      stopReason: data.done_reason,
    };
  }
}
