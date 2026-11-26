import { generateKeyPairSync } from 'node:crypto';
import { Octokit } from '@octokit/rest';
import { describe, expect, it } from 'vitest';
import { createEmbedder, HashingEmbedder, OllamaEmbedder, OpenAiEmbedder } from '../../src/embeddings/index.js';
import { OctokitGateway } from '../../src/github/octokit-gateway.js';
import { createLlmProvider, LlmError } from '../../src/llm/index.js';
import { MockLlmProvider } from '../../src/llm/mock/provider.js';
import { AnthropicProvider } from '../../src/llm/providers/anthropic.js';
import { GeminiProvider } from '../../src/llm/providers/gemini.js';
import { OllamaProvider } from '../../src/llm/providers/ollama.js';
import { OpenAiProvider } from '../../src/llm/providers/openai.js';
import { reportFindingsTool } from '../../src/review/prompts.js';
import { fakeFetch, testEnv } from '../helpers.js';

const request = {
  purpose: 'review:security',
  system: 'You are a reviewer',
  messages: [{ role: 'user' as const, content: 'diff here' }],
  tools: [reportFindingsTool],
};
const findings = { findings: [{ file: 'a.ts', line: 1, end_line: null, severity: 'high', title: 't', explanation: 'e', suggestion: null, rule_id: 'r', confidence: 0.9 }] };

describe('AnthropicProvider (official SDK, mocked HTTP)', () => {
  it('sends strict tools with auto tool_choice, fallbacks and effort; parses tool_use', async () => {
    const http = fakeFetch({
      'POST /v1/messages': () => ({
        body: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [
            { type: 'text', text: 'Reporting.' },
            { type: 'tool_use', id: 'tu_1', name: 'report_findings', input: findings },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 1200, output_tokens: 80 },
        },
      }),
    });
    const llm = new AnthropicProvider({ apiKey: 'sk-ant-test', fetch: http.fetch, effort: 'high' });
    expect(llm.model).toBe('claude-opus-5-5');
    const res = await llm.complete(request);
    expect(res).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5', text: 'Reporting.', usage: { inputTokens: 1200, outputTokens: 80 } });
    expect(res.toolCalls[0]).toEqual({ name: 'report_findings', arguments: findings });
    const sent = http.calls[0]!;
    expect(sent.headers['x-api-key'] ?? sent.headers.authorization).toMatch(/sk-ant-test/);
    expect(sent.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(sent.body).toMatchObject({
      model: 'claude-opus-5-5',
      fallbacks: 'default',
      output_config: { effort: 'high' },
      tool_choice: { type: 'auto' },
      tools: [{ name: 'report_findings', strict: true }],
      system: 'You are a reviewer',
    });
  });

  it('maps refusals and API errors to LlmError', async () => {
    const refusal = fakeFetch({
      'POST /v1/messages': () => ({
        body: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: 'refusal', usage: { input_tokens: 1, output_tokens: 0 } },
      }),
    });
    await expect(new AnthropicProvider({ apiKey: 'k', fetch: refusal.fetch }).complete(request)).rejects.toThrow(/refusal/);
    const bad = fakeFetch({ 'POST /v1/messages': () => ({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } } }) });
    await expect(new AnthropicProvider({ apiKey: 'k', fetch: bad.fetch }).complete(request)).rejects.toBeInstanceOf(LlmError);
  });
});

describe('OpenAiProvider (official SDK, mocked HTTP)', () => {
  it('uses function tools and parses JSON-string arguments', async () => {
    const http = fakeFetch({
      'POST /v1/chat/completions': () => ({
        body: {
          id: 'c1',
          object: 'chat.completion',
          created: 1,
          model: 'gpt-4.1',
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'report_findings', arguments: JSON.stringify(findings) } }] },
            },
          ],
          usage: { prompt_tokens: 900, completion_tokens: 50, total_tokens: 950 },
        },
      }),
    });
    const res = await new OpenAiProvider({ apiKey: 'sk-test', fetch: http.fetch }).complete(request);
    expect(res.toolCalls[0]!.arguments).toEqual(findings);
    expect(res.usage).toEqual({ inputTokens: 900, outputTokens: 50 });
    expect(http.calls[0]!.body).toMatchObject({ tool_choice: 'required', tools: [{ type: 'function', function: { name: 'report_findings', strict: true } }] });
  });

  it('wraps API errors', async () => {
    const http = fakeFetch({ 'POST /v1/chat/completions': () => ({ status: 401, body: { error: { message: 'bad key' } } }) });
    await expect(new OpenAiProvider({ apiKey: 'x', fetch: http.fetch }).complete({ ...request, tools: undefined })).rejects.toBeInstanceOf(LlmError);
  });
});

describe('GeminiProvider and OllamaProvider (REST, mocked HTTP)', () => {
  it('Gemini: function declarations and usage metadata', async () => {
    const http = fakeFetch({
      'POST /v1beta/models/.*': () => ({
        body: {
          candidates: [{ content: { parts: [{ functionCall: { name: 'report_findings', args: findings } }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 40 },
          modelVersion: 'gemini-2.5-pro',
        },
      }),
    });
    const res = await new GeminiProvider({ apiKey: 'g', fetch: http.fetch }).complete(request);
    expect(res.toolCalls[0]!.arguments).toEqual(findings);
    expect(res.usage).toEqual({ inputTokens: 300, outputTokens: 40 });
    expect(http.calls[0]!.headers['x-goog-api-key']).toBe('g');
    const failing = fakeFetch({ 'POST /v1beta/models/.*': () => ({ status: 503, body: {} }) });
    await expect(new GeminiProvider({ apiKey: 'g', fetch: failing.fetch }).complete(request)).rejects.toMatchObject({ retryable: true });
  });

  it('Ollama: /api/chat with tools', async () => {
    const http = fakeFetch({
      'POST /api/chat': () => ({
        body: { model: 'qwen2.5-coder:7b', message: { content: '', tool_calls: [{ function: { name: 'report_findings', arguments: findings } }] }, prompt_eval_count: 10, eval_count: 5, done_reason: 'stop' },
      }),
    });
    const res = await new OllamaProvider({ baseUrl: 'http://ollama:11434/', fetch: http.fetch }).complete(request);
    expect(res).toMatchObject({ provider: 'ollama', usage: { inputTokens: 10, outputTokens: 5 } });
    expect(res.toolCalls[0]!.arguments).toEqual(findings);
    const failing = fakeFetch({ 'POST /api/chat': () => ({ status: 500, body: {} }) });
    await expect(new OllamaProvider({ baseUrl: 'http://o', fetch: failing.fetch }).complete(request)).rejects.toBeInstanceOf(LlmError);
  });

  it('factory selects providers from env', () => {
    expect(createLlmProvider(testEnv())).toBeInstanceOf(MockLlmProvider);
    expect(createLlmProvider(testEnv({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' })).name).toBe('anthropic');
    expect(createLlmProvider(testEnv({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'k', LLM_MODEL: 'gpt-4.1-mini' })).model).toBe('gpt-4.1-mini');
    expect(createLlmProvider(testEnv({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' })).name).toBe('gemini');
    expect(createLlmProvider(testEnv({ LLM_PROVIDER: 'ollama' })).name).toBe('ollama');
  });
});

describe('embedders', () => {
  it('OpenAI and Ollama embedders fold vectors to the index dimension', async () => {
    const http = fakeFetch({
      'POST /v1/embeddings': () => ({ body: { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] } }),
      'POST /api/embed': () => ({ body: { embeddings: [[1, 2, 3, 4]] } }),
    });
    const openai = new OpenAiEmbedder('k', 'text-embedding-3-small', 2, http.fetch);
    expect(await openai.embed(['a', 'b'])).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(await openai.embed([])).toEqual([]);
    const ollama = new OllamaEmbedder('http://o', 'nomic-embed-text', 2, http.fetch);
    const [v] = await ollama.embed(['x']);
    expect(v).toHaveLength(2);
    expect(createEmbedder(testEnv())).toBeInstanceOf(HashingEmbedder);
    expect(createEmbedder(testEnv({ EMBEDDING_PROVIDER: 'ollama' })).name).toBe('ollama');
    expect(createEmbedder(testEnv({ EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: 'k' })).name).toBe('openai');
  });
});

describe('OctokitGateway (mocked GitHub REST API)', () => {
  const ref = { installationId: 77, owner: 'acme', repo: 'api' };
  const routes = {
    'POST /app/installations/77/access_tokens': () => ({ status: 201, body: { token: 'ghs_installation', expires_at: new Date(Date.now() + 3600_000).toISOString() } }),
    'GET /repos/acme/api/pulls/5/files': () => ({ body: [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: '@@ -1 +1,2 @@\n a\n+b' }] }),
    'GET /repos/acme/api/contents/a.ts': () => ({ body: { type: 'file', encoding: 'base64', content: Buffer.from('hello').toString('base64') } }),
    'GET /repos/acme/api/contents/missing.ts': () => ({ status: 404, body: { message: 'Not Found' } }),
    'GET /repos/acme/api/git/trees/main': () => ({ body: { tree: [{ path: 'a.ts', type: 'blob', size: 5 }, { path: 'src', type: 'tree' }] } }),
    'POST /repos/acme/api/pulls/5/reviews': () => ({ body: { id: 999 } }),
    'GET /repos/acme/api/pulls/5/reviews/999/comments': (_b: unknown) => ({ body: [{ id: 1001, path: 'a.ts', line: 2, body: 'comment body' }] }),
    'POST /repos/acme/api/issues/5/comments': () => ({ status: 201, body: { id: 4242 } }),
  };

  it('authenticates as the GitHub App installation and calls the right endpoints', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const http = fakeFetch(routes);
    const gw = new OctokitGateway({ appId: '123', privateKey, fetch: http.fetch });
    expect(gw.mode).toBe('live');

    const files = await gw.listPullRequestFiles(ref, 5);
    expect(files).toEqual([{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n a\n+b', previousFilename: undefined }]);
    expect(await gw.getFileContent(ref, 'a.ts', 'abc')).toBe('hello');
    expect(await gw.getFileContent(ref, 'missing.ts', 'abc')).toBeNull();
    expect(await gw.listFiles(ref, 'main')).toEqual([{ path: 'a.ts', size: 5 }]);

    const created = await gw.createReview(ref, {
      prNumber: 5,
      commitSha: 'deadbeef',
      body: 'summary',
      comments: [
        { path: 'a.ts', line: 2, side: 'RIGHT', body: 'comment body' },
        { path: 'a.ts', line: 6, startLine: 4, side: 'RIGHT', body: 'multi-line\n```suggestion\nx\n```' },
      ],
    });
    expect(created).toEqual({ id: 999, commentIds: [1001, 0] });
    expect(await gw.createIssueComment(ref, 5, 'hi')).toEqual({ id: 4242 });

    const tokenCall = http.calls.find((c) => c.url.includes('/access_tokens'))!;
    expect(tokenCall.headers.authorization).toMatch(/^bearer /i);
    const reviewCall = http.calls.find((c) => c.url.endsWith('/pulls/5/reviews') && c.method === 'POST')!;
    expect(reviewCall.headers.authorization).toBe('token ghs_installation');
    expect(reviewCall.body).toMatchObject({
      commit_id: 'deadbeef',
      event: 'COMMENT',
      comments: [
        { path: 'a.ts', line: 2, side: 'RIGHT' },
        { path: 'a.ts', line: 6, start_line: 4, start_side: 'RIGHT' },
      ],
    });
  });

  it('supports an injected client and requires an installation otherwise', async () => {
    const http = fakeFetch(routes);
    const gw = new OctokitGateway({ appId: '1', privateKey: 'unused', clientFactory: () => new Octokit({ request: { fetch: http.fetch } }) });
    expect(await gw.createIssueComment(ref, 5, 'x')).toEqual({ id: 4242 });
    const noInstall = new OctokitGateway({ appId: '1', privateKey: 'k' });
    await expect(noInstall.listFiles({ ...ref, installationId: null }, 'main')).rejects.toThrow(/installation/);
  });
});
