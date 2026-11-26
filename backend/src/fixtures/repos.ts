/**
 * Fixture repositories and pull requests used by the offline (mock) GitHub gateway,
 * the seed script, tests and the e2e smoke test. Each PR is defined as a set of file
 * changes on top of the repository's base files; patches are computed like GitHub does.
 */
import { createHash } from 'node:crypto';
import { FAKE_STRIPE_KEY } from './fake-secrets.js';

export interface FixturePullRequest {
  number: number;
  title: string;
  author: string;
  headRef: string;
  /** path -> new content (null deletes the file). */
  changes: Record<string, string | null>;
  /** Already merged/closed — used by the seed script to backfill history. */
  historical?: boolean;
  /** Override the derived head commit sha (tests simulating new pushes). */
  headSha?: string;
}

export interface FixtureRepository {
  githubId: number;
  installationId: number;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
  files: Record<string, string>;
  pullRequests: FixturePullRequest[];
}

export const fixtureSha = (...parts: (string | number)[]) => createHash('sha1').update(parts.join(':')).digest('hex');

// ----------------------------------------------------------------------------- acme/payments-api

const paymentsDb = `import { Pool } from 'pg';

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function query<T>(text: string, params: unknown[] = []): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}
`;

const paymentsCustomers = `import { query } from '../db';

export interface Customer {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
}

export async function getCustomerById(id: string): Promise<Customer | undefined> {
  const rows = await query<Customer>('SELECT id, email, name, created_at FROM customers WHERE id = $1', [id]);
  return rows[0];
}
`;

const paymentsLedger = `import { query } from '../db';

export interface LedgerEntry {
  id: string;
  paymentId: string;
  amountCents: number;
  currency: string;
}

export async function recordEntry(entry: LedgerEntry): Promise<void> {
  await query(
    'INSERT INTO ledger_entries (id, payment_id, amount_cents, currency) VALUES ($1, $2, $3, $4)',
    [entry.id, entry.paymentId, entry.amountCents, entry.currency],
  );
}

export async function balanceFor(paymentId: string): Promise<number> {
  const rows = await query<{ total: number }>('SELECT COALESCE(SUM(amount_cents), 0) AS total FROM ledger_entries WHERE payment_id = $1', [paymentId]);
  return rows[0]?.total ?? 0;
}
`;

const paymentsMoney = `export function formatCents(amountCents: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amountCents / 100);
}

export function toCents(amount: string): number {
  return Math.round(Number(amount) * 100);
}
`;

const paymentsRoutes = `import { Router } from 'express';
import { getCustomerById } from '../services/customers';

export const router = Router();

router.get('/customers/:id', async (req, res) => {
  const customer = await getCustomerById(req.params.id);
  if (!customer) return res.status(404).json({ error: 'not_found' });
  return res.json(customer);
});
`;

const paymentsConfig = `# CodeSentinel configuration
tone: friendly
severity_threshold: low
max_findings: 25
ignore:
  - "docs/**"
  - "**/*.md"
rules:
  disabled: []
  instructions:
    - "All money values are integer cents; flag floating point arithmetic on amounts."
`;

const paymentsRepo: FixtureRepository = {
  githubId: 700001,
  installationId: 9100,
  owner: 'acme',
  name: 'payments-api',
  defaultBranch: 'main',
  private: true,
  files: {
    '.codesentinel.yml': paymentsConfig,
    'package.json': '{\n  "name": "payments-api",\n  "version": "2.3.0",\n  "dependencies": { "express": "^4.19.0", "pg": "^8.11.0" }\n}\n',
    'package-lock.json': '{\n  "name": "payments-api",\n  "lockfileVersion": 3,\n  "packages": {}\n}\n',
    'src/db.ts': paymentsDb,
    'src/services/customers.ts': paymentsCustomers,
    'src/services/ledger.ts': paymentsLedger,
    'src/utils/money.ts': paymentsMoney,
    'src/routes/customers.ts': paymentsRoutes,
    'docs/architecture.md': '# Payments API\n\nExpress + Postgres service handling card payments and the double-entry ledger.\n',
  },
  pullRequests: [
    {
      number: 101,
      title: 'Add customer search endpoint',
      author: 'dana-dev',
      headRef: 'feature/customer-search',
      changes: {
        'src/services/customers.ts': `${paymentsCustomers}
export async function searchCustomers(term: string, limit = 20): Promise<Customer[]> {
  console.log('searching customers', term);
  const rows = await query<Customer>("SELECT * FROM customers WHERE email LIKE '%" + term + "%' LIMIT " + limit);
  return rows;
}

export function isVip(customer: Customer, lifetimeCents: number): boolean {
  if (customer.email == 'ceo@acme.test') return true;
  return lifetimeCents > 1_000_000;
}
`,
        'src/routes/customers.ts': `import { Router } from 'express';
import { getCustomerById, searchCustomers } from '../services/customers';

export const router = Router();

const STRIPE_SECRET_KEY = "${FAKE_STRIPE_KEY}";

router.get('/customers/search', async (req, res) => {
  const limit = parseInt(String(req.query.limit ?? '20'));
  const results = await searchCustomers(String(req.query.q ?? ''), limit);
  return res.json({ results, provider: STRIPE_SECRET_KEY.slice(0, 7) });
});

router.get('/customers/:id', async (req, res) => {
  const customer = await getCustomerById(req.params.id);
  if (!customer) return res.status(404).json({ error: 'not_found' });
  return res.json(customer);
});
`,
        'docs/architecture.md': '# Payments API\n\nExpress + Postgres service handling card payments, customer search and the double-entry ledger.\n',
      },
    },
    {
      number: 102,
      title: 'Batch settlement of pending payments',
      author: 'li-wei',
      headRef: 'feature/batch-settlement',
      changes: {
        'src/services/settlement.ts': `import { query } from '../db';
import { recordEntry, type LedgerEntry } from './ledger';

interface PendingPayment {
  id: string;
  amountCents: number;
  currency: string;
  merchantId: string;
}

export async function settlePending(merchantIds: string[]): Promise<number> {
  const payments = await query<PendingPayment>('SELECT id, amount_cents, currency, merchant_id FROM payments WHERE status = $1', ['pending']);
  let settled = 0;
  for (let i = 0; i <= payments.length; i++) {
    const payment = payments[i];
    const merchant = merchantIds.find((m) => m === payment.merchantId);
    if (!merchant) continue;
    const entry: LedgerEntry = { id: crypto.randomUUID(), paymentId: payment.id, amountCents: payment.amountCents, currency: payment.currency };
    try {
      await recordEntry(entry);
      await query('UPDATE payments SET status = $1 WHERE id = $2', ['settled', payment.id]);
      settled++;
    } catch (err) {}
  }
  return settled;
}

export function settlementFee(amountCents: number): number {
  var fee = amountCents * 0.029 + 30;
  return Math.round(fee);
}
`,
        'package-lock.json': `{\n  "name": "payments-api",\n  "lockfileVersion": 3,\n  "packages": {\n${Array.from({ length: 40 }, (_, i) => `    "node_modules/dep-${i}": { "version": "1.0.${i}" }`).join(',\n')}\n  }\n}\n`,
      },
    },
    {
      number: 103,
      title: 'Refactor money helpers and add rounding modes',
      author: 'sam-k',
      headRef: 'refactor/money',
      changes: {
        'src/utils/money.ts': `export type RoundingMode = 'half-up' | 'bankers';

export function formatCents(amountCents: number, currency = 'USD', locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amountCents / 100);
}

export function toCents(amount: string, mode: RoundingMode = 'half-up'): number {
  const value = Number(amount) * 100;
  if (mode === 'bankers') {
    const floor = Math.floor(value);
    const diff = value - floor;
    return diff === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(value);
  }
  return Math.round(value);
}

export function sumCents(values: number[]): number {
  return values.reduce((total, v) => total + v, 0);
}
`,
      },
    },
    {
      number: 142,
      title: 'Partner webhook signature verification',
      author: 'marco-p',
      headRef: 'feature/partner-webhooks',
      changes: {
        'src/webhooks/partners.ts': `import { createHash } from 'node:crypto';
import https from 'node:https';

const agent = new https.Agent({ rejectUnauthorized: false });

export function verifyPartnerSignature(body: string, signature: string, secret: string): boolean {
  const digest = createHash('md5').update(secret + body).digest('hex');
  return digest == signature;
}

export function parsePartnerPayload(raw: string): Record<string, unknown> {
  return eval('(' + raw + ')');
}

export function issueReplayToken(partnerId: string): string {
  const token = partnerId + '-' + Math.random().toString(36).slice(2);
  return token;
}

export async function forward(url: string, payload: Record<string, unknown>): Promise<void> {
  const copy = JSON.parse(JSON.stringify(payload));
  await fetch(url, { method: 'POST', body: JSON.stringify(copy), dispatcher: agent } as RequestInit);
}
`,
      },
    },
  ],
};

// ----------------------------------------------------------------------------- acme/web-dashboard

const dashboardApi = `export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(\`Request failed: \${res.status}\`);
  return (await res.json()) as T;
}
`;

const dashboardUserCard = `import type { User } from '../types';

export function UserCard({ user }: { user: User }) {
  return (
    <article className="card">
      <h3>{user.name}</h3>
      <p>{user.title}</p>
    </article>
  );
}
`;

const webRepo: FixtureRepository = {
  githubId: 700002,
  installationId: 9100,
  owner: 'acme',
  name: 'web-dashboard',
  defaultBranch: 'main',
  private: false,
  files: {
    'src/lib/api.ts': dashboardApi,
    'src/components/UserCard.tsx': dashboardUserCard,
    'src/types.ts': 'export interface User {\n  id: string;\n  name: string;\n  title: string;\n  bio?: string;\n}\n\nexport interface Order {\n  id: string;\n  totalCents: number;\n  status: string;\n}\n',
    'dist/bundle.min.js': '!function(){var a=1;console.log(a)}();'.repeat(200),
  },
  pullRequests: [
    {
      number: 57,
      title: 'Render rich user bios on profile cards',
      author: 'priya-ui',
      headRef: 'feature/rich-bio',
      changes: {
        'src/components/UserCard.tsx': `import type { User } from '../types';

export function UserCard({ user, compact }: { user: User; compact?: boolean }) {
  const settings: any = JSON.parse(JSON.stringify(user));
  const label = compact ? 'short' : settings.bio ? 'long' : 'empty';
  return (
    <article className="card" data-variant={label}>
      <h3>{user.name}</h3>
      <p>{user.title}</p>
      <div dangerouslySetInnerHTML={{ __html: user.bio ?? '' }} />
    </article>
  );
}
`,
        'src/lib/highlight.ts': `export function highlight(container: HTMLElement, term: string) {
  var html = container.textContent ?? '';
  container.innerHTML = html.replace(term, '<mark>' + term + '</mark>');
}
`,
        'dist/bundle.min.js': '!function(){var b=2;console.log(b)}();'.repeat(220),
      },
    },
    {
      number: 58,
      title: 'Orders hook with background refresh',
      author: 'tom-react',
      headRef: 'feature/orders-hook',
      changes: {
        'src/hooks/useOrders.ts': `import { useEffect, useState } from 'react';
import { getJson } from '../lib/api';
import type { Order } from '../types';

export function useOrders(customerIds: string[]) {
  const [orders, setOrders] = useState<Order[]>([]);

  useEffect(() => {
    // TODO: add pagination once the API supports cursors
    customerIds.forEach(async (id) => {
      const page = await getJson<Order[]>(\`/api/customers/\${id}/orders\`);
      setOrders((prev) => [...prev, ...page]);
    });
    getJson<Order[]>('/api/orders/recent').then((recent) => setOrders((prev) => [...recent, ...prev]));
  }, [customerIds]);

  return orders;
}
`,
      },
    },
  ],
};

// ----------------------------------------------------------------------------- acme/ml-pipeline

const pipelineLoader = `import json
from pathlib import Path


def load_json(path: str) -> dict:
    with Path(path).open() as fh:
        return json.load(fh)
`;

const mlConfig = `tone: strict
severity_threshold: medium
passes:
  readability: false
ignore:
  - "notebooks/**"
`;

const mlRepo: FixtureRepository = {
  githubId: 700003,
  installationId: 9200,
  owner: 'acme',
  name: 'ml-pipeline',
  defaultBranch: 'main',
  private: true,
  files: {
    '.codesentinel.yml': mlConfig,
    'pipeline/loader.py': pipelineLoader,
    'pipeline/__init__.py': '',
    'notebooks/exploration.py': 'print("scratch")\n',
  },
  pullRequests: [
    {
      number: 12,
      title: 'YAML experiment configs and feature cache',
      author: 'nina-ml',
      headRef: 'feature/yaml-configs',
      changes: {
        'pipeline/loader.py': `${pipelineLoader}

import pickle
import sqlite3
import yaml


def load_experiment(path: str) -> dict:
    with open(path) as fh:
        return yaml.load(fh)


def load_feature_cache(blob: bytes):
    try:
        return pickle.loads(blob)
    except:
        return None


def fetch_runs(conn: sqlite3.Connection, experiment: str, tags=[]):
    cursor = conn.cursor()
    cursor.execute(f"SELECT id, score FROM runs WHERE experiment = '{experiment}'")
    print("fetched runs for", experiment)
    return cursor.fetchall()
`,
        'notebooks/exploration.py': 'print("scratch v2")\nimport pickle\npickle.loads(b"")\n',
      },
    },
    {
      number: 13,
      title: 'Download datasets from the feature store',
      author: 'omar-data',
      headRef: 'feature/dataset-download',
      changes: {
        'pipeline/download.py': `import re
import requests

API_TOKEN = "fs_token_8f2b9c4d1e7a6b5c"


def download_all(urls: list[str]) -> list[bytes]:
    blobs = []
    for url in urls:
        pattern = re.compile(r"^https://")
        if not pattern.match(url):
            continue
        response = requests.get(url, headers={"Authorization": API_TOKEN}, verify=False)
        blobs.append(response.content)
    return blobs
`,
      },
    },
  ],
};

/** Merged/closed PRs from the last month (reuse the change sets of the open PRs) for realistic history. */
const HISTORY_TITLES: Record<string, string[]> = {
  'payments-api': [
    'Add refunds endpoint',
    'Nightly ledger reconciliation',
    'Customer export for finance',
    'Retry failed settlements',
    'Currency conversion service',
    'Merchant payout report',
  ],
  'web-dashboard': ['Profile page redesign', 'Order history table', 'Inline search highlighting', 'Customer timeline widget'],
  'ml-pipeline': ['Experiment registry', 'Cache embeddings to disk', 'Hyperparameter sweep runner', 'Dataset versioning'],
};
const HISTORY_AUTHORS = ['dana-dev', 'li-wei', 'sam-k', 'priya-ui', 'tom-react', 'nina-ml', 'omar-data', 'marco-p'];

function withHistory(repo: FixtureRepository, exclude: number[] = []): FixtureRepository {
  const sources = repo.pullRequests.filter((p) => !exclude.includes(p.number));
  const titles = HISTORY_TITLES[repo.name] ?? [];
  const history = titles.map((title, i) => {
    const src = sources[i % sources.length]!;
    return {
      number: Math.max(1, sources[0]!.number - (titles.length - i) * 3),
      title,
      author: HISTORY_AUTHORS[(i + repo.name.length) % HISTORY_AUTHORS.length]!,
      headRef: `history/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      changes: src.changes,
      historical: true,
    };
  });
  return { ...repo, pullRequests: [...history, ...repo.pullRequests] };
}

export const FIXTURE_REPOSITORIES: FixtureRepository[] = [withHistory(paymentsRepo, [142]), withHistory(webRepo), withHistory(mlRepo)];

/** PR used by the webhook smoke/e2e test — intentionally not reviewed by the seed script. */
export const SMOKE_TEST_PR = { repo: 'acme/payments-api', number: 142 };

export function findFixtureRepo(fullName: string): FixtureRepository | undefined {
  return FIXTURE_REPOSITORIES.find((r) => `${r.owner}/${r.name}` === fullName);
}

export function prShas(repo: FixtureRepository, pr: FixturePullRequest) {
  return { baseSha: fixtureSha(repo.owner, repo.name, 'base'), headSha: pr.headSha ?? fixtureSha(repo.owner, repo.name, pr.number, 'head') };
}

/** Build a GitHub `pull_request` webhook payload for a fixture PR. */
export function buildPullRequestEvent(
  fullName: string,
  number: number,
  action: 'opened' | 'synchronize' | 'reopened' = 'opened',
  repos: FixtureRepository[] = FIXTURE_REPOSITORIES,
) {
  const repo = repos.find((r) => `${r.owner}/${r.name}` === fullName);
  const pr = repo?.pullRequests.find((p) => p.number === number);
  if (!repo || !pr) throw new Error(`Unknown fixture PR ${fullName}#${number}`);
  const { baseSha, headSha } = prShas(repo, pr);
  return {
    action,
    number: pr.number,
    pull_request: {
      number: pr.number,
      title: pr.title,
      html_url: `https://github.com/${fullName}/pull/${pr.number}`,
      state: 'open',
      draft: false,
      user: { login: pr.author },
      head: { sha: headSha, ref: pr.headRef },
      base: { sha: baseSha, ref: repo.defaultBranch },
    },
    repository: {
      id: repo.githubId,
      name: repo.name,
      full_name: fullName,
      private: repo.private,
      default_branch: repo.defaultBranch,
      owner: { login: repo.owner },
    },
    installation: { id: repo.installationId },
    sender: { login: pr.author },
  };
}
