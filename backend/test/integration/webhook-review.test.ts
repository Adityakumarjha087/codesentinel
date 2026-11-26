import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeChunks, findings, llmUsage, repositories, reviewFiles, reviews } from '../../src/db/schema.js';
import { FIXTURE_REPOSITORIES, type FixtureRepository } from '../../src/fixtures/repos.js';
import { MockGitHubGateway } from '../../src/github/mock-gateway.js';
import { createTestApp, prEvent, signedWebhook } from '../helpers.js';

describe('GitHub webhook -> queue -> multi-pass review -> GitHub comments', () => {
  let t: Awaited<ReturnType<typeof createTestApp>>;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t.close());

  it('rejects unsigned or wrongly signed deliveries', async () => {
    const payload = prEvent('acme/payments-api', 142);
    const bad = await t.app.inject(signedWebhook('pull_request', payload, { secret: 'wrong' }));
    expect(bad.statusCode).toBe(401);
    const missing = await t.app.inject({ ...signedWebhook('pull_request', payload), headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request' } });
    expect(missing.statusCode).toBe(401);
    const noEvent = await t.app.inject({ method: 'POST', url: '/api/webhooks/github', payload: '{}', headers: { 'content-type': 'application/json' } });
    expect(noEvent.statusCode).toBe(400);
  });

  it('answers ping and ignores unhandled events', async () => {
    expect((await t.app.inject(signedWebhook('ping', { zen: 'Keep it logically awesome.' }))).json()).toMatchObject({ status: 'processed', reason: 'pong' });
    expect((await t.app.inject(signedWebhook('star', { action: 'created' }))).json()).toMatchObject({ status: 'ignored' });
  });

  it('reviews a signed pull_request.opened fixture end-to-end', async () => {
    const res = await t.app.inject(signedWebhook('pull_request', prEvent('acme/payments-api', 142), { delivery: 'delivery-142' }));
    expect(res.statusCode).toBe(202);
    const { status, reviewId } = res.json() as { status: string; reviewId: string };
    expect(status).toBe('queued');
    await t.queue.drain();

    const [review] = await t.container.db.select().from(reviews).where(eq(reviews.id, reviewId));
    expect(review).toMatchObject({ status: 'completed', filesReviewed: 1, provider: 'mock', model: 'codesentinel-mock-1' });
    expect(review!.passes).toEqual(['bugs', 'security', 'performance', 'readability']);
    expect(review!.inputTokens).toBeGreaterThan(0);
    expect(review!.costUsd).toBeGreaterThan(0);
    expect(review!.githubReviewId).toBeTruthy();
    expect(review!.summaryCommentId).toBeTruthy();

    const items = await t.container.db.select().from(findings).where(eq(findings.reviewId, reviewId));
    const rules = items.map((f) => f.ruleId).sort();
    expect(rules).toEqual(
      expect.arrayContaining(['security/code-eval', 'security/tls-verification-disabled', 'security/weak-hash', 'security/insecure-random', 'performance/json-deep-clone', 'bugs/loose-equality']),
    );
    const evalFinding = items.find((f) => f.ruleId === 'security/code-eval')!;
    expect(evalFinding).toMatchObject({ severity: 'critical', category: 'security', filePath: 'src/webhooks/partners.ts', symbol: 'parsePartnerPayload', inDiff: true });
    expect(evalFinding.codeSnippet).toContain('eval(');

    // Usage: one row per pass.
    const usage = await t.container.db.select().from(llmUsage).where(eq(llmUsage.reviewId, reviewId));
    expect(usage.map((u) => u.purpose).sort()).toEqual(['review:bugs', 'review:performance', 'review:readability', 'review:security']);

    // Posted to (mock) GitHub: inline comments with suggestion blocks + one summary comment.
    const posted = t.gateway.reviews.find((r) => r.prNumber === 142)!;
    expect(posted.commitSha).toBe(review!.headSha);
    expect(posted.comments).toHaveLength(items.filter((f) => f.inDiff).length);
    expect(posted.comments.some((c) => c.body.includes('```suggestion'))).toBe(true);
    expect(posted.comments.every((c) => c.side === 'RIGHT' && c.path === 'src/webhooks/partners.ts')).toBe(true);
    const summary = t.gateway.issueComments.find((c) => c.prNumber === 142)!;
    expect(summary.body).toContain('## CodeSentinel review');
    expect(summary.body).toContain('CRITICAL');

    // Files are stored for the diff viewer and the repo was indexed for context.
    const files = await t.container.db.select().from(reviewFiles).where(eq(reviewFiles.reviewId, reviewId));
    expect(files[0]).toMatchObject({ path: 'src/webhooks/partners.ts', status: 'added', language: 'typescript' });
    expect(files[0]!.headContent).toContain('verifyPartnerSignature');
    expect(files[0]!.symbols.map((s) => s.name)).toContain('parsePartnerPayload');
    const [repo] = await t.container.db.select().from(repositories).where(eq(repositories.fullName, 'acme/payments-api'));
    expect(repo!.indexedSha).toBeTruthy();
    const chunks = await t.container.db.select({ id: codeChunks.id }).from(codeChunks).where(eq(codeChunks.repoId, repo!.id));
    expect(chunks.length).toBeGreaterThan(3);
  });

  it('is idempotent for duplicate deliveries and already-reviewed commits', async () => {
    const dup = await t.app.inject(signedWebhook('pull_request', prEvent('acme/payments-api', 142), { delivery: 'delivery-142' }));
    expect(dup.json()).toMatchObject({ status: 'duplicate' });
    const sameCommit = await t.app.inject(signedWebhook('pull_request', prEvent('acme/payments-api', 142, 'reopened')));
    expect(sameCommit.json()).toMatchObject({ status: 'duplicate', reason: 'commit already reviewed' });
  });

  it('ignores drafts and non-review actions', async () => {
    const draft = prEvent('acme/web-dashboard', 57);
    draft.pull_request.draft = true;
    expect((await t.app.inject(signedWebhook('pull_request', draft))).json()).toMatchObject({ status: 'ignored', reason: 'draft pull request' });
    const labeled = { ...prEvent('acme/web-dashboard', 57), action: 'labeled' };
    expect((await t.app.inject(signedWebhook('pull_request', labeled))).json()).toMatchObject({ status: 'ignored' });
    expect((await t.app.inject(signedWebhook('pull_request', { action: 'opened' }))).json()).toMatchObject({ status: 'ignored', reason: 'malformed pull_request payload' });
  });

  it('skips lock files and config-ignored paths and applies the repo severity threshold', async () => {
    const res = await t.app.inject(signedWebhook('pull_request', prEvent('acme/ml-pipeline', 12)));
    await t.queue.drain();
    const reviewId = res.json().reviewId as string;
    const [review] = await t.container.db.select().from(reviews).where(eq(reviews.id, reviewId));
    expect(review!.filesSkipped).toEqual([{ path: 'notebooks/exploration.py', reason: 'ignored by .codesentinel.yml' }]);
    expect(review!.passes).toEqual(['bugs', 'security', 'performance']); // readability disabled in config
    const items = await t.container.db.select().from(findings).where(eq(findings.reviewId, reviewId));
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((f) => ['medium', 'high', 'critical'].includes(f.severity))).toBe(true); // threshold: medium
    expect(items.map((f) => f.ruleId)).toContain('security/sql-injection');
    expect(t.gateway.issueComments.find((c) => c.prNumber === 12)!.body).toMatch(/must be addressed/); // strict tone
  });

  it('handles installation events by connecting repos and indexing them', async () => {
    const res = await t.app.inject(
      signedWebhook('installation_repositories', {
        action: 'added',
        installation: { id: 9100, account: { login: 'acme' } },
        repositories_added: [{ id: 700002, name: 'web-dashboard', full_name: 'acme/web-dashboard', private: false }],
        repositories_removed: [{ id: 123456, full_name: 'acme/legacy' }],
      }),
    );
    expect(res.json()).toMatchObject({ status: 'processed', reason: '1 repositories connected, 1 removed' });
    await t.queue.drain();
    const [repo] = await t.container.db.select().from(repositories).where(eq(repositories.fullName, 'acme/web-dashboard'));
    expect(repo!.indexedAt).toBeTruthy();
    const del = await t.app.inject(signedWebhook('installation', { action: 'deleted', installation: { id: 9100 } }));
    expect(del.json()).toMatchObject({ status: 'processed' });
    const [paused] = await t.container.db.select().from(repositories).where(eq(repositories.fullName, 'acme/web-dashboard'));
    expect(paused!.isActive).toBe(false);
    expect((await t.app.inject(signedWebhook('pull_request', prEvent('acme/web-dashboard', 58)))).json()).toMatchObject({ status: 'ignored', reason: 'repository is paused in CodeSentinel' });
  });
});

describe('acceptance tracking on synchronize', () => {
  it('marks findings accepted when the suggestion is applied in a later commit', async () => {
    const base = FIXTURE_REPOSITORIES.find((r) => r.name === 'payments-api')!;
    const pr = base.pullRequests.find((p) => p.number === 102)!;
    const settlement = pr.changes['src/services/settlement.ts']!;
    const fixed = settlement.replace('i <= payments.length', 'i < payments.length').replace('var fee', 'let fee');
    const repo: FixtureRepository = {
      ...base,
      pullRequests: [pr, { ...pr, number: 102, headSha: 'f'.repeat(40), headRef: 'feature/batch-settlement-v2', changes: { ...pr.changes, 'src/services/settlement.ts': fixed } }],
    };
    // Gateway serving commit 1 first, then commit 2 for the same PR number.
    const gateway = new MockGitHubGateway([{ ...repo, pullRequests: [pr] }]);
    const t = await createTestApp({}, { gateway });
    try {
      const first = await t.app.inject(signedWebhook('pull_request', prEvent('acme/payments-api', 102)));
      await t.queue.drain();
      const firstId = first.json().reviewId as string;
      const before = await t.container.db.select().from(findings).where(eq(findings.reviewId, firstId));
      expect(before.find((f) => f.ruleId === 'bugs/off-by-one')?.status).toBe('open');

      // Push a second commit that applies two suggestions.
      (gateway as unknown as { repos: FixtureRepository[] }).repos = [{ ...repo, pullRequests: [repo.pullRequests[1]!] }];
      const event = prEvent('acme/payments-api', 102, 'synchronize');
      event.pull_request.head.sha = 'f'.repeat(40);
      event.pull_request.head.ref = 'feature/batch-settlement-v2';
      await t.app.inject(signedWebhook('pull_request', event));
      await t.queue.drain();

      const after = await t.container.db.select().from(findings).where(eq(findings.reviewId, firstId));
      expect(after.find((f) => f.ruleId === 'bugs/off-by-one')?.status).toBe('accepted');
      expect(after.find((f) => f.ruleId === 'readability/var-declaration')?.status).toBe('accepted');
      expect(after.find((f) => f.ruleId === 'bugs/empty-catch')?.status).toBe('open');
    } finally {
      await t.close();
    }
  });
});
