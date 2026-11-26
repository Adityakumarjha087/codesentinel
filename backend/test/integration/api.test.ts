import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDatabase } from '../../src/db/seed-data.js';
import { createTestApp, fakeFetch, login, prEvent, signedWebhook } from '../helpers.js';

describe('REST API', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  let admin: Awaited<ReturnType<typeof login>>;
  let viewer: Awaited<ReturnType<typeof login>>;
  let maintainer: Awaited<ReturnType<typeof login>>;

  beforeAll(async () => {
    t = await createTestApp();
    const summary = await seedDatabase(t.container, { now: new Date() });
    expect(summary).toMatchObject({ skipped: false, repositories: 3, users: 3 });
    expect(summary.reviews).toBeGreaterThan(15);
    expect(summary.findings).toBeGreaterThan(50);
    expect((await seedDatabase(t.container)).skipped).toBe(true);
    admin = await login(t.app, 'admin');
    viewer = await login(t.app, 'viewer');
    maintainer = await login(t.app, 'maintainer');
  });
  afterAll(async () => t.close());

  it('exposes health and OpenAPI docs', async () => {
    const health = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'ok', checks: { database: true, queue: true }, llm: { provider: 'mock' }, github: 'mock', queue: 'inline' });
    const docs = await t.app.inject({ method: 'GET', url: '/docs/json' });
    expect(docs.statusCode).toBe(200);
    expect(Object.keys(docs.json().paths)).toEqual(expect.arrayContaining(['/api/webhooks/github', '/api/reviews/{id}', '/api/pull-requests/{id}/chat']));
  });

  describe('auth', () => {
    it('requires a bearer token and rejects bad tokens', async () => {
      expect((await t.app.inject({ method: 'GET', url: '/api/repos' })).statusCode).toBe(401);
      const bad = await t.app.inject({ method: 'GET', url: '/api/repos', headers: { authorization: 'Bearer nope' } });
      expect(bad.statusCode).toBe(401);
      expect(bad.json()).toMatchObject({ error: 'unauthorized' });
    });

    it('returns the current user and login config', async () => {
      const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: admin.headers });
      expect(me.json()).toMatchObject({ login: 'test-admin', role: 'admin' });
      expect((await t.app.inject({ method: 'GET', url: '/api/auth/config' })).json()).toEqual({ githubOAuth: false, devLogin: true });
    });

    it('rotates refresh tokens and detects reuse', async () => {
      const session = await login(t.app, 'viewer', 'rotation-user');
      const first = await t.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { cs_refresh: session.refreshCookie } });
      expect(first.statusCode).toBe(200);
      const next = first.cookies.find((c) => c.name === 'cs_refresh')!.value;
      expect(next).not.toBe(session.refreshCookie);
      // Reusing the old token revokes the family, including the new one.
      expect((await t.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { cs_refresh: session.refreshCookie } })).statusCode).toBe(401);
      expect((await t.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { cs_refresh: next } })).statusCode).toBe(401);
      expect((await t.app.inject({ method: 'POST', url: '/api/auth/refresh' })).statusCode).toBe(401);
    });

    it('logs out by revoking the refresh token', async () => {
      const session = await login(t.app, 'viewer', 'logout-user');
      expect((await t.app.inject({ method: 'POST', url: '/api/auth/logout', cookies: { cs_refresh: session.refreshCookie } })).statusCode).toBe(204);
      expect((await t.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { cs_refresh: session.refreshCookie } })).statusCode).toBe(401);
    });

    it('validates dev-login input', async () => {
      const res = await t.app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { login: 'bad login!', role: 'admin' } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'validation_error' });
      expect((await t.app.inject({ method: 'GET', url: '/api/auth/github/login' })).statusCode).toBe(404);
    });
  });

  describe('RBAC', () => {
    it('restricts admin and maintainer operations', async () => {
      const repos = (await t.app.inject({ method: 'GET', url: '/api/repos', headers: viewer.headers })).json() as { id: string }[];
      const id = repos[0]!.id;
      expect((await t.app.inject({ method: 'PATCH', url: `/api/repos/${id}`, headers: viewer.headers, payload: { isActive: false } })).statusCode).toBe(403);
      expect((await t.app.inject({ method: 'PATCH', url: `/api/repos/${id}`, headers: maintainer.headers, payload: { isActive: false } })).statusCode).toBe(403);
      expect((await t.app.inject({ method: 'GET', url: '/api/users', headers: maintainer.headers })).statusCode).toBe(403);
      expect((await t.app.inject({ method: 'POST', url: `/api/repos/${id}/reindex`, headers: viewer.headers })).statusCode).toBe(403);
    });
  });

  it('lists repositories with usage and lets admins update budgets', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/repos', headers: admin.headers });
    const repos = res.json() as { id: string; fullName: string; reviewCount: number; tokensThisMonth: number; totalFindings: number }[];
    expect(repos.map((r) => r.fullName)).toEqual(['acme/ml-pipeline', 'acme/payments-api', 'acme/web-dashboard']);
    expect(repos.every((r) => r.reviewCount > 0 && r.totalFindings > 0)).toBe(true);
    const id = repos[1]!.id;
    const patched = await t.app.inject({ method: 'PATCH', url: `/api/repos/${id}`, headers: admin.headers, payload: { monthlyTokenBudget: 5_000_000 } });
    expect(patched.json()).toMatchObject({ monthlyTokenBudget: 5_000_000 });
    expect((await t.app.inject({ method: 'PATCH', url: `/api/repos/${id}`, headers: admin.headers, payload: { monthlyTokenBudget: 1 } })).statusCode).toBe(400);
    const detail = (await t.app.inject({ method: 'GET', url: `/api/repos/${id}`, headers: viewer.headers })).json();
    expect(detail.usageByMonth.length).toBeGreaterThan(0);
    expect(detail.recentReviews.length).toBeGreaterThan(0);
    expect((await t.app.inject({ method: 'POST', url: `/api/repos/${id}/reindex`, headers: maintainer.headers })).statusCode).toBe(202);
    expect((await t.app.inject({ method: 'GET', url: '/api/repos/00000000-0000-0000-0000-000000000000', headers: admin.headers })).statusCode).toBe(404);
  });

  it('pages review history and returns review detail for the diff viewer', async () => {
    const list = (await t.app.inject({ method: 'GET', url: '/api/reviews?pageSize=5', headers: viewer.headers })).json();
    expect(list.items).toHaveLength(5);
    expect(list.total).toBeGreaterThan(15);
    const completed = (await t.app.inject({ method: 'GET', url: '/api/reviews?status=completed&pageSize=100', headers: viewer.headers })).json();
    const withFindings = completed.items.find((r: { findingsCount: number }) => r.findingsCount > 3);
    expect(withFindings.bySeverity).toBeTypeOf('object');
    const detail = (await t.app.inject({ method: 'GET', url: `/api/reviews/${withFindings.id}`, headers: viewer.headers })).json();
    expect(detail.files.length).toBeGreaterThan(0);
    expect(detail.files.find((f: { skippedReason: string | null }) => !f.skippedReason).headContent).toBeTruthy();
    expect(detail.findings.length).toBe(withFindings.findingsCount);
    expect(detail.pullRequest.number).toBe(withFindings.pullRequest.number);
    const rerun = await t.app.inject({ method: 'POST', url: `/api/reviews/${withFindings.id}/rerun`, headers: maintainer.headers });
    expect(rerun.statusCode).toBe(202);
    await t.queue.drain();
    expect((await t.app.inject({ method: 'GET', url: '/api/reviews/not-a-uuid', headers: viewer.headers })).statusCode).toBe(400);
  });

  it('records feedback on findings and filters them', async () => {
    const list = (await t.app.inject({ method: 'GET', url: '/api/findings?category=security&status=open', headers: viewer.headers })).json();
    expect(list.items.every((f: { category: string }) => f.category === 'security')).toBe(true);
    const id = list.items[0].id as string;
    expect((await t.app.inject({ method: 'PATCH', url: `/api/findings/${id}`, headers: viewer.headers, payload: { status: 'accepted' } })).statusCode).toBe(403);
    const ok = await t.app.inject({ method: 'PATCH', url: `/api/findings/${id}`, headers: maintainer.headers, payload: { status: 'accepted' } });
    expect(ok.json()).toMatchObject({ status: 'accepted' });
    expect(ok.json().resolvedAt).toBeTruthy();
    expect((await t.app.inject({ method: 'PATCH', url: `/api/findings/${id}`, headers: maintainer.headers, payload: { status: 'resolved' } })).statusCode).toBe(400);
  });

  it('computes dashboard analytics', async () => {
    const stats = (await t.app.inject({ method: 'GET', url: '/api/stats/overview?days=30', headers: viewer.headers })).json();
    expect(stats.reviews.total).toBeGreaterThan(15);
    expect(stats.timeline).toHaveLength(30);
    expect(stats.timeline.reduce((s: number, d: { total: number }) => s + d.total, 0)).toBe(stats.findings.total);
    expect(stats.acceptanceRate).toBeGreaterThan(0.3);
    expect(stats.acceptanceRate).toBeLessThan(1);
    expect(stats.byCategory.map((c: { category: string }) => c.category).sort()).toEqual(['bug', 'performance', 'readability', 'security']);
    expect(stats.usage.byRepo).toHaveLength(3);
    expect(stats.usage.costUsd).toBeGreaterThan(0);
    expect(stats.topRules.length).toBeGreaterThan(3);
    const repoId = stats.usage.byRepo[0].repoId;
    const scoped = (await t.app.inject({ method: 'GET', url: `/api/stats/overview?days=7&repoId=${repoId}`, headers: viewer.headers })).json();
    expect(scoped.timeline).toHaveLength(7);
    expect(scoped.usage.byRepo.length).toBeLessThanOrEqual(1);
  });

  it('answers chat questions about a PR using its review', async () => {
    const reviews = (await t.app.inject({ method: 'GET', url: '/api/reviews?pageSize=100', headers: viewer.headers })).json();
    const pr = reviews.items.find((r: { pullRequest: { number: number }; repo: { fullName: string } }) => r.pullRequest.number === 101 && r.repo.fullName === 'acme/payments-api').pullRequest;
    const history = (await t.app.inject({ method: 'GET', url: `/api/pull-requests/${pr.id}/chat`, headers: viewer.headers })).json();
    expect(history).toHaveLength(2); // seeded conversation
    const res = await t.app.inject({ method: 'POST', url: `/api/pull-requests/${pr.id}/chat`, headers: viewer.headers, payload: { message: 'Is there any security risk in this PR and how do I fix it?' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.answer.content).toMatch(/Hardcoded secret|SQL injection/);
    expect(body.answer.sources.length).toBeGreaterThan(0);
    expect((await t.app.inject({ method: 'POST', url: `/api/pull-requests/${pr.id}/chat`, headers: viewer.headers, payload: { message: '' } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'POST', url: '/api/pull-requests/00000000-0000-0000-0000-000000000000/chat', headers: viewer.headers, payload: { message: 'hi' } })).statusCode).toBe(404);
  });

  it('lets admins manage user roles', async () => {
    const users = (await t.app.inject({ method: 'GET', url: '/api/users', headers: admin.headers })).json() as { id: string; login: string }[];
    const victor = users.find((u) => u.login === 'victor-view')!;
    expect((await t.app.inject({ method: 'PATCH', url: `/api/users/${victor.id}`, headers: admin.headers, payload: { role: 'maintainer' } })).json()).toMatchObject({ role: 'maintainer' });
    expect((await t.app.inject({ method: 'PATCH', url: `/api/users/${admin.user.id}`, headers: admin.headers, payload: { role: 'viewer' } })).statusCode).toBe(400);
  });

  it('returns JSON 404s for unknown routes', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
  });

  it('reviews the smoke-test PR via signed webhook after seeding', async () => {
    const res = await t.app.inject(signedWebhook('pull_request', prEvent('acme/payments-api', 142)));
    expect(res.json()).toMatchObject({ status: 'queued' });
  });
});

describe('GitHub OAuth login', () => {
  it('exchanges the code, creates the first user as admin and sets a refresh cookie', async () => {
    const http = fakeFetch({
      'POST /login/oauth/access_token': () => ({ body: { access_token: 'gho_test' } }),
      'GET /user': () => ({ body: { id: 42, login: 'octocat', name: 'The Octocat', email: null, avatar_url: 'https://example.com/a.png' } }),
    });
    const t = await createTestApp({ GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'secret', AUTH_DEV_LOGIN: 'false' }, { fetch: http.fetch });
    try {
      const start = await t.app.inject({ method: 'GET', url: '/api/auth/github/login' });
      expect(start.statusCode).toBe(302);
      expect(start.headers.location).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?client_id=cid/);
      const state = start.cookies.find((c) => c.name === 'cs_oauth_state')!.value;
      expect((await t.app.inject({ method: 'GET', url: `/api/auth/github/callback?code=abc&state=wrong`, cookies: { cs_oauth_state: state } })).statusCode).toBe(401);
      const cb = await t.app.inject({ method: 'GET', url: `/api/auth/github/callback?code=abc&state=${state}`, cookies: { cs_oauth_state: state } });
      expect(cb.statusCode).toBe(302);
      const refresh = cb.cookies.find((c) => c.name === 'cs_refresh')!;
      expect(refresh.httpOnly).toBe(true);
      const session = await t.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { cs_refresh: refresh.value } });
      expect(session.json().user).toMatchObject({ login: 'octocat', role: 'admin' });
      expect(http.calls[0]!.body).toMatchObject({ client_id: 'cid', client_secret: 'secret', code: 'abc' });
      expect((await t.app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: {} })).statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });

  it('surfaces OAuth failures', async () => {
    const http = fakeFetch({ 'POST /login/oauth/access_token': () => ({ body: { error_description: 'bad_verification_code' } }) });
    const t = await createTestApp({ GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'secret' }, { fetch: http.fetch });
    try {
      const res = await t.app.inject({ method: 'GET', url: '/api/auth/github/callback?code=x&state=s', cookies: { cs_oauth_state: 's' } });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: 'oauth_failed', message: 'bad_verification_code' });
    } finally {
      await t.close();
    }
  });
});
