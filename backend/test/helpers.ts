import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { buildApp } from '../src/app.js';
import { loadEnv, type Env } from '../src/config/env.js';
import { createContainer, type Container, type ContainerOverrides } from '../src/container.js';
import { createDatabase } from '../src/db/client.js';
import { buildPullRequestEvent } from '../src/fixtures/repos.js';
import { MockGitHubGateway } from '../src/github/mock-gateway.js';
import { signPayload } from '../src/github/signature.js';
import { InlineQueue } from '../src/queue/index.js';

export const WEBHOOK_SECRET = 'test-webhook-secret';
export const silentLogger = pino({ level: 'silent' });

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_DRIVER: 'pglite',
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    JWT_SECRET: 'test-jwt-secret-at-least-16-chars',
    RATE_LIMIT_MAX: '10000',
    ...overrides,
  });
}

export interface TestContext {
  container: Container;
  gateway: MockGitHubGateway;
  queue: InlineQueue;
  close(): Promise<void>;
}

export async function createTestContainer(envOverrides: Record<string, string> = {}, overrides: ContainerOverrides = {}): Promise<TestContext> {
  const dbHandle = await createDatabase({ driver: 'pglite' });
  await dbHandle.migrate();
  const gateway = (overrides.gateway as MockGitHubGateway | undefined) ?? new MockGitHubGateway();
  const queue = new InlineQueue(silentLogger);
  const container = await createContainer(testEnv(envOverrides), { logger: silentLogger, dbHandle, gateway, queue, ...overrides });
  await queue.startWorker((job) => container.handleJob(job));
  return { container, gateway, queue, close: () => container.close() };
}

export async function createTestApp(envOverrides: Record<string, string> = {}, overrides: ContainerOverrides = {}) {
  const ctx = await createTestContainer(envOverrides, overrides);
  const app = await buildApp(ctx.container);
  await app.ready();
  return {
    ...ctx,
    app,
    async close() {
      await app.close();
      await ctx.close();
    },
  };
}

export function signedWebhook(event: string, payload: unknown, opts: { secret?: string; delivery?: string } = {}) {
  const body = JSON.stringify(payload);
  return {
    method: 'POST' as const,
    url: '/api/webhooks/github',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': opts.delivery ?? randomUUID(),
      'x-hub-signature-256': signPayload(opts.secret ?? WEBHOOK_SECRET, body),
    },
    payload: body,
  };
}

export const prEvent = buildPullRequestEvent;

export async function login(app: Awaited<ReturnType<typeof createTestApp>>['app'], role: 'admin' | 'maintainer' | 'viewer' = 'admin', loginName?: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { login: loginName ?? `test-${role}`, role } });
  const body = res.json() as { accessToken: string; user: { id: string } };
  const cookie = res.cookies.find((c) => c.name === 'cs_refresh');
  return { token: body.accessToken, user: body.user, refreshCookie: cookie?.value ?? '', headers: { authorization: `Bearer ${body.accessToken}` } };
}

/** Minimal fetch double: route by "METHOD path" and record calls. */
export function fakeFetch(routes: Record<string, (body: unknown, url: URL, init?: RequestInit) => { status?: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: { method: string; url: string; body: unknown; headers: Record<string, string> }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    let rawBody: unknown = init?.body;
    if (rawBody === undefined && input instanceof Request) rawBody = await input.text();
    let body: unknown = rawBody;
    if (typeof rawBody === 'string' && rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => (headers[k] = v));
    calls.push({ method, url: url.toString(), body, headers });
    const key = Object.keys(routes).find((k) => {
      const [m, pattern] = k.split(' ');
      return m === method && new RegExp(`^${pattern}$`).test(url.pathname);
    });
    if (!key) return new Response(JSON.stringify({ message: `no route for ${method} ${url.pathname}` }), { status: 404, headers: { 'content-type': 'application/json' } });
    const out = routes[key]!(body, url, init);
    return new Response(out.body === undefined ? null : JSON.stringify(out.body), {
      status: out.status ?? 200,
      headers: { 'content-type': 'application/json', ...(out.headers ?? {}) },
    });
  }) as typeof fetch;
  return { fetch: impl, calls };
}
