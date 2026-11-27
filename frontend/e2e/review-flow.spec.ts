import { createHash, createHmac, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

const API = process.env.E2E_API_URL ?? 'http://localhost:20301';
const SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? 'codesentinel-dev-webhook-secret';
const sha = (...parts: (string | number)[]) => createHash('sha1').update(parts.join(':')).digest('hex');

/** Same payload GitHub sends for `pull_request.opened` on the fixture PR acme/payments-api#142. */
function pullRequestOpened() {
  return {
    action: 'opened',
    number: 142,
    pull_request: {
      number: 142,
      title: 'Partner webhook signature verification',
      html_url: 'https://github.com/acme/payments-api/pull/142',
      state: 'open',
      draft: false,
      user: { login: 'marco-p' },
      head: { sha: sha('acme', 'payments-api', 142, 'head'), ref: 'feature/partner-webhooks' },
      base: { sha: sha('acme', 'payments-api', 'base'), ref: 'main' },
    },
    repository: { id: 700001, name: 'payments-api', full_name: 'acme/payments-api', private: true, default_branch: 'main', owner: { login: 'acme' } },
    installation: { id: 9100 },
  };
}

test('signed webhook -> AI review -> dashboard diff, triage and PR chat', async ({ page, request }) => {
  // 1. GitHub delivers a signed pull_request webhook.
  const body = JSON.stringify(pullRequestOpened());
  const hook = await request.post(`${API}/api/webhooks/github`, {
    data: body,
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-github-delivery': randomUUID(),
      'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
    },
  });
  expect(hook.status()).toBe(202);
  const { reviewId } = (await hook.json()) as { reviewId: string };
  expect(reviewId).toBeTruthy();

  // An unsigned delivery is rejected.
  const unsigned = await request.post(`${API}/api/webhooks/github`, { data: body, headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request' } });
  expect(unsigned.status()).toBe(401);

  // 2. Sign in with the demo account (maintainer can triage).
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Username').fill('maria-maint');
  await page.getByLabel('Role').selectOption('maintainer');
  await page.getByRole('button', { name: 'Sign in with demo account' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByTestId('stat-reviews')).not.toHaveText('0');
  await expect(page.getByText('Findings over time')).toBeVisible();

  // 3. Open the review; wait for the worker to finish it.
  await page.goto(`/reviews/${reviewId}`);
  await expect(page.getByRole('heading', { name: '#142 Partner webhook signature verification' })).toBeVisible();
  await expect(page.getByTestId('review-meta').getByText('completed')).toBeVisible({ timeout: 30_000 });
  const evalFinding = page.getByRole('article', { name: 'Dynamic code execution with eval' });
  await expect(evalFinding).toBeVisible();
  await expect(evalFinding.getByText('Critical')).toBeVisible();
  await expect(page.getByRole('article', { name: 'TLS certificate verification disabled' })).toBeVisible();

  // 4. Monaco diff viewer with inline AI comments.
  await expect(page.getByTestId('diff-viewer')).toBeVisible();
  await expect(page.getByTestId('inline-comment').first()).toBeVisible({ timeout: 30_000 });

  // 5. Triage: accept a suggestion, then reopen it (keeps the test re-runnable).
  const weakHash = page.getByRole('article', { name: 'Weak hash algorithm' });
  await weakHash.getByRole('button', { name: /^Accept/ }).click();
  await expect(weakHash.getByText('accepted')).toBeVisible();
  await weakHash.getByRole('button', { name: /^Reopen/ }).click();
  await expect(weakHash.getByText('open', { exact: true })).toBeVisible();

  // 6. Chat with the PR.
  await page.getByLabel('Ask about this pull request').fill('Which security issues should I fix first?');
  await page.getByRole('button', { name: 'Send question' }).click();
  await expect(page.getByTestId('chat-log').getByText(/Dynamic code execution with eval/).last()).toBeVisible();

  // 7. Dark mode toggle and history page.
  await page.getByRole('button', { name: /Switch to (dark|light) mode/ }).click();
  await page.getByRole('link', { name: 'Reviews', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review history' })).toBeVisible();
  await expect(page.getByRole('link', { name: /#142 Partner webhook signature verification/ }).first()).toBeVisible();
});

test('viewers cannot triage findings or see the team page', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill('victor-view');
  await page.getByLabel('Role').selectOption('viewer');
  await page.getByRole('button', { name: 'Sign in with demo account' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Team' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Repositories' }).click();
  await expect(page.getByTestId('repo-row')).toHaveCount(3);
  await page.getByRole('link', { name: 'Reviews', exact: true }).click();
  await page.getByRole('link', { name: /#101 Add customer search endpoint/ }).first().click();
  await expect(page.getByRole('article').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Accept/ })).toHaveCount(0);
});
