import { asc, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { chatMessages, findings, llmUsage, pullRequests, repositories, reviewFiles, reviews } from '../db/schema.js';
import type { RepositoryIndexer } from '../indexing/indexer.js';
import { notFound } from '../lib/errors.js';
import { costUsd } from '../llm/pricing.js';
import type { LlmMessage, LlmProvider } from '../llm/types.js';

const SYSTEM_PROMPT = [
  'You are CodeSentinel, an assistant that answers questions about a specific pull request.',
  'Ground every answer in the provided review findings, changed files and repository snippets. Cite files as `path:line`.',
  'If the context does not contain the answer, say so plainly instead of guessing. Be concise and use Markdown.',
].join('\n');

export interface ChatSource {
  type: 'finding' | 'file' | 'snippet';
  ref: string;
  label: string;
}

export class PrChatService {
  constructor(
    private readonly db: Database,
    private readonly llm: LlmProvider,
    private readonly indexer: RepositoryIndexer,
  ) {}

  async history(pullRequestId: string) {
    return this.db.select().from(chatMessages).where(eq(chatMessages.pullRequestId, pullRequestId)).orderBy(asc(chatMessages.createdAt));
  }

  async ask(pullRequestId: string, userId: string | null, question: string) {
    const [row] = await this.db
      .select({ pr: pullRequests, repo: repositories })
      .from(pullRequests)
      .innerJoin(repositories, eq(pullRequests.repoId, repositories.id))
      .where(eq(pullRequests.id, pullRequestId));
    if (!row) throw notFound('Pull request');
    const { pr, repo } = row;

    const [latest] = await this.db.select().from(reviews).where(eq(reviews.pullRequestId, pr.id)).orderBy(desc(reviews.createdAt)).limit(1);
    const prFindings = latest ? await this.db.select().from(findings).where(eq(findings.reviewId, latest.id)).limit(60) : [];
    const files = latest
      ? await this.db
          .select({ path: reviewFiles.path, status: reviewFiles.status, additions: reviewFiles.additions, deletions: reviewFiles.deletions, patch: reviewFiles.patch, skippedReason: reviewFiles.skippedReason })
          .from(reviewFiles)
          .where(eq(reviewFiles.reviewId, latest.id))
      : [];
    const snippets = await this.indexer.search(repo.id, question, { k: 4, minScore: 0.1 }).catch(() => []);

    const sources: ChatSource[] = [
      ...prFindings.slice(0, 8).map((f) => ({ type: 'finding' as const, ref: f.id, label: `${f.filePath}:${f.line}` })),
      ...snippets.map((s) => ({ type: 'snippet' as const, ref: `${s.path}:${s.startLine}`, label: `${s.path}${s.symbol ? ` (${s.symbol})` : ''}` })),
    ];

    const context = [
      `Repository: ${repo.fullName}`,
      `Pull request #${pr.number}: ${pr.title}`,
      `Author: ${pr.author} · ${pr.headRef} -> ${pr.baseRef}`,
      latest ? `Latest review status: ${latest.status}${latest.skipReason ? ` (${latest.skipReason})` : ''}` : 'No review has run yet.',
      '<findings>',
      ...prFindings.map(
        (f) =>
          `- [${f.severity}][${f.category}] ${f.filePath}:${f.line} — ${f.title}${f.suggestion ? ` || suggestion: ${f.suggestion.replace(/\s*\n\s*/g, ' ')}` : ''}`,
      ),
      '</findings>',
      '<changed_files>',
      ...files.map((f) => `- ${f.path} (${f.status}, +${f.additions}/-${f.deletions})${f.skippedReason ? ` skipped: ${f.skippedReason}` : ''}`),
      '</changed_files>',
      '<diffs>',
      ...files.filter((f) => f.patch && !f.skippedReason).map((f) => `<diff path="${f.path}">\n${(f.patch ?? '').slice(0, 3000)}\n</diff>`),
      '</diffs>',
      '<related_code>',
      ...snippets.map((s) => `<snippet path="${s.path}" lines="${s.startLine}-${s.endLine}">\n${s.content.slice(0, 1200)}\n</snippet>`),
      '</related_code>',
    ].join('\n');

    const previous = (await this.history(pr.id)).slice(-8);
    const messages: LlmMessage[] = [
      ...previous.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: `${context}\n\nQuestion: ${question}` },
    ];
    // Providers require alternating turns starting with the user.
    while (messages.length && messages[0]!.role !== 'user') messages.shift();

    const res = await this.llm.complete({ purpose: 'chat', system: SYSTEM_PROMPT, messages, maxOutputTokens: 1500 });
    await this.db.insert(llmUsage).values({
      repoId: repo.id,
      reviewId: latest?.id ?? null,
      purpose: 'chat',
      provider: res.provider,
      model: res.model,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      costUsd: costUsd(res.provider, res.model, res.usage.inputTokens, res.usage.outputTokens),
    });
    const [userMsg] = await this.db.insert(chatMessages).values({ pullRequestId: pr.id, userId, role: 'user', content: question }).returning();
    const [answer] = await this.db
      .insert(chatMessages)
      .values({ pullRequestId: pr.id, userId: null, role: 'assistant', content: res.text || 'I could not produce an answer.', sources })
      .returning();
    return { question: userMsg!, answer: answer! };
  }
}
