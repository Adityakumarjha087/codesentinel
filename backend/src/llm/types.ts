export type LlmProviderName = 'mock' | 'openai' | 'anthropic' | 'gemini' | 'ollama';

/** JSON-Schema object describing a tool's arguments (provider-neutral). */
export interface JsonSchemaObject {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
  [key: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
}

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  /** Logical purpose, used for usage accounting (e.g. `review:security`, `chat`). */
  purpose: string;
  system: string;
  messages: LlmMessage[];
  tools?: ToolDefinition[];
  maxOutputTokens?: number;
}

export interface LlmToolCall {
  name: string;
  arguments: unknown;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResponse {
  text: string;
  toolCalls: LlmToolCall[];
  usage: LlmUsage;
  provider: LlmProviderName;
  model: string;
  stopReason?: string;
}

export interface LlmProvider {
  readonly name: LlmProviderName;
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export type FetchLike = typeof fetch;

export class LlmError extends Error {
  constructor(
    message: string,
    public readonly provider: LlmProviderName,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** Parse a tool-call argument payload that may arrive as a JSON string or an object. */
export function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
