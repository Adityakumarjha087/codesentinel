import { and, eq, ne } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { findings, reviews } from '../db/schema.js';

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

export type AcceptanceOutcome = 'accepted' | 'resolved' | 'open';

/**
 * Decide what happened to a finding after new commits:
 * - suggestion text now present and flagged code gone -> accepted (suggestion applied)
 * - flagged code gone otherwise                      -> resolved (fixed differently)
 */
export function classifyFinding(f: { suggestion: string | null; codeSnippet: string | null }, newContent: string | null): AcceptanceOutcome {
  if (newContent === null) return 'resolved';
  const content = normalize(newContent);
  const snippet = f.codeSnippet ? normalize(f.codeSnippet) : '';
  const snippetGone = snippet !== '' && !content.includes(snippet);
  if (f.suggestion !== null) {
    const suggestion = normalize(f.suggestion);
    if (suggestion === '' && snippetGone) return 'accepted';
    if (suggestion !== '' && content.includes(suggestion) && snippetGone) return 'accepted';
  }
  return snippetGone ? 'resolved' : 'open';
}

/** Update open findings from earlier reviews of this PR based on the new head contents. */
export async function trackAcceptance(
  db: Database,
  pullRequestId: string,
  headSha: string,
  _known: Map<string, string | null>,
  contentFor: (path: string) => Promise<string | null>,
): Promise<{ accepted: number; resolved: number }> {
  const open = await db
    .select({ id: findings.id, filePath: findings.filePath, suggestion: findings.suggestion, codeSnippet: findings.codeSnippet })
    .from(findings)
    .innerJoin(reviews, eq(findings.reviewId, reviews.id))
    .where(and(eq(findings.pullRequestId, pullRequestId), eq(findings.status, 'open'), ne(reviews.headSha, headSha)));
  let accepted = 0;
  let resolved = 0;
  for (const f of open) {
    const outcome = classifyFinding(f, await contentFor(f.filePath));
    if (outcome === 'open') continue;
    await db.update(findings).set({ status: outcome, resolvedAt: new Date() }).where(eq(findings.id, f.id));
    if (outcome === 'accepted') accepted++;
    else resolved++;
  }
  return { accepted, resolved };
}
