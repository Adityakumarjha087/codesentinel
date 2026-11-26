#!/usr/bin/env node
/**
 * Reproducible README screenshots against a running stack (docker compose up + seed).
 *
 *   node scripts/screenshots.mjs            # writes docs/screenshots/*.png
 *
 * Uses the Playwright install from frontend/node_modules. Shows only seeded fixture data.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'frontend', 'package.json'));
const { chromium } = require('@playwright/test');

const WEB = process.env.WEB ?? 'http://localhost:20300';
const API = process.env.API ?? 'http://localhost:20301';
const SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? 'codesentinel-dev-webhook-secret';
const OUT = join(root, 'docs', 'screenshots');
mkdirSync(OUT, { recursive: true });

const sha = (...p) => createHash('sha1').update(p.join(':')).digest('hex');

/** Signed fixture webhook for acme/payments-api#142 (no secret-like literals in its diff). */
async function reviewId() {
  const body = JSON.stringify({
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
  });
  const res = await fetch(`${API}/api/webhooks/github`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-github-delivery': randomUUID(),
      'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
    },
    body,
  });
  const json = await res.json();
  if (!json.reviewId) throw new Error(`webhook failed: ${JSON.stringify(json)}`);
  return json.reviewId;
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light' });
const page = await context.newPage();
/** Scroll so `selector` sits just below the sticky 56px header. */
const scrollTo = (selector) =>
  page.locator(selector).first().evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 72));
const shot = async (name) => {
  await page.waitForTimeout(800); // let chart/editor animations settle
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`saved docs/screenshots/${name}.png`);
};

try {
  const id = await reviewId();

  // Login as admin with the demo account.
  await page.goto(`${WEB}/login`);
  await page.evaluate(() => localStorage.setItem('theme', 'light'));
  await page.getByLabel('Username').fill('demo-admin');
  await page.getByLabel('Role').selectOption('admin');
  await page.getByRole('button', { name: 'Sign in with demo account' }).click();
  await page.getByRole('heading', { name: 'Overview' }).waitFor();

  // 1. Overview dashboard with charts.
  await page.getByText('Findings over time').waitFor();
  await page.locator('.recharts-area-area').first().waitFor({ state: 'attached' });
  await shot('dashboard');

  // 2. Review detail: Monaco diff with inline AI comments.
  await page.goto(`${WEB}/reviews/${id}`);
  await page.getByTestId('inline-comment').first().waitFor({ timeout: 30_000 });
  await scrollTo('main h1');
  await shot('review-diff');

  // 3. Findings with suggested fixes + PR chat answer.
  // Ask once; re-runs reuse the stored conversation instead of duplicating it.
  const answered = await page.getByTestId('chat-log').getByText('Which security issues should I fix first?').count();
  if (!answered) {
    await page.getByLabel('Ask about this pull request').fill('Which security issues should I fix first?');
    await page.getByRole('button', { name: 'Send question' }).click();
  }
  await page.getByTestId('chat-log').getByText('I would address the high-severity items before merging.').last().waitFor();
  await scrollTo('#findings-heading');
  await shot('findings-and-chat');

  // 4. Review history.
  await page.goto(`${WEB}/reviews`);
  await page.getByRole('link', { name: /#142/ }).first().waitFor();
  await shot('review-history');

  // 5. Repositories with token budgets and cost.
  await page.goto(`${WEB}/repos`);
  await page.getByTestId('repo-row').first().waitFor();
  await shot('repositories');

  // 6. Dark mode review detail.
  await page.evaluate(() => localStorage.setItem('theme', 'dark'));
  await page.goto(`${WEB}/reviews/${id}`);
  await page.getByTestId('inline-comment').first().waitFor({ timeout: 30_000 }).catch(async (err) => {
    await page.screenshot({ path: join(OUT, '_debug.png'), fullPage: true });
    throw err;
  });
  await scrollTo('main h1');
  await shot('review-diff-dark');
} finally {
  await browser.close();
}
