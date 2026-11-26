import type { Env } from '../config/env.js';
import { EMBEDDING_DIMENSIONS } from '../db/schema.js';
import type { FetchLike } from '../llm/types.js';

export interface Embedder {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

/** Split identifiers (camelCase, snake_case) and keep alphanumeric code tokens. */
export function codeTokens(text: string): string[] {
  const raw = text.match(/[A-Za-z_][A-Za-z0-9_]*|\d+/g) ?? [];
  const out: string[] = [];
  for (const tok of raw) {
    const lower = tok.toLowerCase();
    if (lower.length > 1) out.push(lower);
    const parts = tok
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[_\s]+/)
      .map((p) => p.toLowerCase())
      .filter((p) => p.length > 1);
    if (parts.length > 1) out.push(...parts);
  }
  return out;
}

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function l2normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map((x) => x / norm);
}

/** Reduce an arbitrary-length vector to `dims` by signed folding, then normalize. */
export function foldVector(v: number[], dims: number): number[] {
  if (v.length === dims) return l2normalize(v);
  const out = new Array<number>(dims).fill(0);
  v.forEach((x, i) => {
    out[i % dims]! += x;
  });
  return l2normalize(out);
}

/**
 * Offline feature-hashing embedder (unigrams + bigrams of code tokens, signed hashing, log-tf).
 * Deterministic and dependency-free; good enough for lexical/semantic-ish code retrieval in tests and demos.
 */
export class HashingEmbedder implements Embedder {
  readonly name = 'hash';
  constructor(readonly dimensions = EMBEDDING_DIMENSIONS) {}

  embedOne(text: string): number[] {
    const vec = new Array<number>(this.dimensions).fill(0);
    const tokens = codeTokens(text);
    const counts = new Map<string, number>();
    tokens.forEach((t, i) => {
      counts.set(t, (counts.get(t) ?? 0) + 1);
      const next = tokens[i + 1];
      if (next) counts.set(`${t} ${next}`, (counts.get(`${t} ${next}`) ?? 0) + 0.5);
    });
    for (const [feature, count] of counts) {
      const h = fnv1a(feature);
      const sign = (h & 1) === 0 ? 1 : -1;
      vec[h % this.dimensions]! += sign * (1 + Math.log(count));
    }
    return l2normalize(vec);
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }
}

export class OpenAiEmbedder implements Embedder {
  readonly name = 'openai';
  constructor(
    private readonly apiKey: string,
    private readonly model = 'text-embedding-3-small',
    readonly dimensions = EMBEDDING_DIMENSIONS,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = 'https://api.openai.com/v1',
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const res = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: texts, dimensions: this.dimensions }),
    });
    if (!res.ok) throw new Error(`OpenAI embeddings error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    return data.data.sort((a, b) => a.index - b.index).map((d) => foldVector(d.embedding, this.dimensions));
  }
}

export class OllamaEmbedder implements Embedder {
  readonly name = 'ollama';
  constructor(
    private readonly baseUrl: string,
    private readonly model = 'nomic-embed-text',
    readonly dimensions = EMBEDDING_DIMENSIONS,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) throw new Error(`Ollama embeddings error ${res.status}`);
    const data = (await res.json()) as { embeddings: number[][] };
    return data.embeddings.map((e) => foldVector(e, this.dimensions));
  }
}

export function createEmbedder(env: Pick<Env, 'EMBEDDING_PROVIDER' | 'EMBEDDING_MODEL' | 'OPENAI_API_KEY' | 'OLLAMA_BASE_URL'>, fetchImpl?: FetchLike): Embedder {
  switch (env.EMBEDDING_PROVIDER) {
    case 'openai':
      return new OpenAiEmbedder(env.OPENAI_API_KEY ?? '', env.EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, fetchImpl);
    case 'ollama':
      return new OllamaEmbedder(env.OLLAMA_BASE_URL, env.EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, fetchImpl);
    default:
      return new HashingEmbedder();
  }
}
