/**
 * Send a signed fixture `pull_request` webhook to a running CodeSentinel API (smoke test helper).
 *
 *   npm run webhook:send -- --url http://localhost:20301 --repo acme/payments-api --pr 142
 */
import { randomUUID } from 'node:crypto';
import { buildPullRequestEvent, SMOKE_TEST_PR } from '../src/fixtures/repos.js';
import { signPayload } from '../src/github/signature.js';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};

const url = arg('url', process.env.API_URL ?? 'http://localhost:20301');
const repo = arg('repo', SMOKE_TEST_PR.repo);
const pr = Number(arg('pr', String(SMOKE_TEST_PR.number)));
const action = arg('action', 'opened') as 'opened' | 'synchronize' | 'reopened';
const secret = process.env.GITHUB_WEBHOOK_SECRET ?? 'codesentinel-dev-webhook-secret';

const body = JSON.stringify(buildPullRequestEvent(repo, pr, action));
const res = await fetch(`${url}/api/webhooks/github`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-github-event': 'pull_request',
    'x-github-delivery': randomUUID(),
    'x-hub-signature-256': signPayload(secret, body),
  },
  body,
});
console.log(res.status, await res.text());
if (!res.ok) process.exit(1);
