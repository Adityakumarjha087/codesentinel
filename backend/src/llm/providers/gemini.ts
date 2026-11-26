import { LlmError, type FetchLike, type LlmProvider, type LlmRequest, type LlmResponse, type LlmToolCall } from '../types.js';

export interface GeminiProviderOptions {
  apiKey: string;
  model?: string;
  maxOutputTokens?: number;
  fetch?: FetchLike;
  baseUrl?: string;
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: unknown };
}

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  modelVersion?: string;
}

/** Google Gemini via the public generateContent REST API with function declarations. */
export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini' as const;
  readonly model: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly opts: GeminiProviderOptions) {
    this.model = opts.model ?? 'gemini-2.5-pro';
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const base = this.opts.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: req.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: req.maxOutputTokens ?? this.opts.maxOutputTokens ?? 4096 },
      ...(req.tools?.length
        ? {
            tools: [
              {
                functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })),
              },
            ],
            toolConfig: { functionCallingConfig: { mode: 'ANY' } },
          }
        : {}),
    };
    const res = await this.fetchImpl(`${base}/models/${encodeURIComponent(this.model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.opts.apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new LlmError(`Gemini API error ${res.status}: ${await res.text()}`, 'gemini', res.status === 429 || res.status >= 500);
    }
    const data = (await res.json()) as GeminiResponse;
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const toolCalls: LlmToolCall[] = parts.filter((p) => p.functionCall).map((p) => ({ name: p.functionCall!.name, arguments: p.functionCall!.args ?? {} }));
    return {
      text: parts.map((p) => p.text ?? '').join(''),
      toolCalls,
      usage: { inputTokens: data.usageMetadata?.promptTokenCount ?? 0, outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0 },
      provider: 'gemini',
      model: data.modelVersion ?? this.model,
      stopReason: data.candidates?.[0]?.finishReason,
    };
  }
}
