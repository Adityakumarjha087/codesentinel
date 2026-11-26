import { createHash } from 'node:crypto';
import { and, eq, gte, ne, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  findings as findingsTable,
  llmUsage,
  pullRequests,
  repositories,
  reviewFiles,
  reviews,
  type FindingCategory,
  type NewFinding,
  type PullRequest,
  type Repository,
  type SkippedFile,
} from '../db/schema.js';
import { formatInlineComment, formatSummary } from '../github/comments.js';
import type { GitHubGateway, InlineComment, PullRequestFile, RepoRef } from '../github/types.js';
import type { RepositoryIndexer } from '../indexing/indexer.js';
import type { Logger } from '../lib/logger.js';
import { estimateTokens } from '../lib/tokens.js';
import { costUsd } from '../llm/pricing.js';
import { parseToolArguments, type LlmProvider } from '../llm/types.js';
import { commentableLines, countChanges, parsePatch, renderNumberedDiff, type DiffHunk } from '../parsing/diff.js';
import { detectLanguage, displayLanguage, enclosingSymbols, extractSymbols, sliceLines, type CodeSymbol } from '../parsing/treesitter.js';
import { trackAcceptance } from './acceptance.js';
import {
  CONFIG_FILE_NAME,
  createIgnoreMatcher,
  DEFAULT_IGNORES,
  looksGenerated,
  parseRepoConfig,
  REVIEW_PASS_IDS,
  severityRank,
  type RepoConfig,
  type ReviewPassId,
} from './config.js';
import {
  buildReviewUserPrompt,
  buildSystemPrompt,
  PASSES,
  rawFindingSchema,
  REPORT_FINDINGS_TOOL,
  reportFindingsTool,
  type PromptFile,
  type PromptRelatedChunk,
} from './prompts.js';

export interface ReviewEngineOptions {
  maxFileChangedLines: number;
  maxReviewInputTokens: number;
  dashboardUrl?: string;
  passConcurrency?: number;
  /** Per-LLM-call timeout; a timed-out pass fails gracefully without failing the whole review. */
  llmTimeoutMs?: number;
}

export interface ReviewEngineDeps {
  db: Database;
  gateway: GitHubGateway;
  llm: LlmProvider;
  indexer: RepositoryIndexer;
  logger: Logger;
  options: ReviewEngineOptions;
}

interface PreparedFile {
  file: PullRequestFile;
  hunks: DiffHunk[];
  headContent: string;
  symbols: CodeSymbol[];
  commentable: Set<number>;
  prompt: PromptFile;
}

const MAX_STORED_CONTENT = 200_000;
const MAX_SYMBOL_CONTEXT_LINES = 150;

export const fingerprintOf = (path: string, line: number, ruleOrTitle: string) =>
  createHash('sha1').update(`${path}:${line}:${ruleOrTitle.toLowerCase()}`).digest('hex').slice(0, 16);

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export function startOfMonth(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function monthlyTokensUsed(db: Database, repoId: string, now = new Date()): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${llmUsage.inputTokens} + ${llmUsage.outputTokens}), 0)` })
    .from(llmUsage)
    .where(and(eq(llmUsage.repoId, repoId), gte(llmUsage.createdAt, startOfMonth(now))));
  return Number(row?.total ?? 0);
}

export class ReviewEngine {
  constructor(private readonly deps: ReviewEngineDeps) {}

  async run(reviewId: string): Promise<void> {
    const { db, logger } = this.deps;
    const [row] = await db
      .select({ review: reviews, pr: pullRequests, repo: repositories })
      .from(reviews)
      .innerJoin(pullRequests, eq(reviews.pullRequestId, pullRequests.id))
      .innerJoin(repositories, eq(reviews.repoId, repositories.id))
      .where(eq(reviews.id, reviewId));
    if (!row) throw new Error(`Review ${reviewId} not found`);
    if (row.review.status === 'completed' || row.review.status === 'skipped') return; // idempotent retries

    const started = Date.now();
    await db.update(reviews).set({ status: 'running', startedAt: new Date(), error: null }).where(eq(reviews.id, reviewId));
    const log = logger.child({ reviewId, repo: row.repo.fullName, pr: row.pr.number });
    try {
      await this.execute(reviewId, row.repo, row.pr, log);
      await db.update(reviews).set({ durationMs: Date.now() - started }).where(eq(reviews.id, reviewId));
    } catch (err) {
      log.error({ err }, 'review failed');
      await db
        .update(reviews)
        .set({ status: 'failed', error: (err as Error).message.slice(0, 2000), completedAt: new Date(), durationMs: Date.now() - started })
        .where(eq(reviews.id, reviewId));
      throw err;
    }
  }

  private async execute(reviewId: string, repo: Repository, pr: PullRequest, log: Logger): Promise<void> {
    const { db, gateway, llm, options } = this.deps;
    const ref: RepoRef = { installationId: repo.installationId, owner: repo.owner, repo: repo.name };
    // A retried job (worker crash / BullMQ retry) must not duplicate rows from a previous attempt.
    await db.delete(findingsTable).where(eq(findingsTable.reviewId, reviewId));
    await db.delete(reviewFiles).where(eq(reviewFiles.reviewId, reviewId));

    // 1. Per-repo configuration from the PR head.
    const { config, errors: configErrors, source } = parseRepoConfig(await gateway.getFileContent(ref, CONFIG_FILE_NAME, pr.headSha));
    await db.update(repositories).set({ config: { ...config, source, errors: configErrors } }).where(eq(repositories.id, repo.id));

    // 2. Changed files + filtering of ignored / generated / huge files.
    const files = await gateway.listPullRequestFiles(ref, pr.number);
    const isDefaultIgnored = createIgnoreMatcher(DEFAULT_IGNORES);
    const isConfigIgnored = createIgnoreMatcher(config.ignore);
    const maxLines = config.maxFileChangedLines ?? options.maxFileChangedLines;
    const skipped: SkippedFile[] = [];
    const prepared: PreparedFile[] = [];
    const headContents = new Map<string, string | null>();

    for (const file of files) {
      const skip = (reason: string) => skipped.push({ path: file.filename, reason });
      if (file.status === 'removed') {
        skip('file removed');
        headContents.set(file.filename, null);
        continue;
      }
      if (isDefaultIgnored(file.filename)) {
        skip('generated, vendored or lock file');
        continue;
      }
      if (isConfigIgnored(file.filename)) {
        skip('ignored by .codesentinel.yml');
        continue;
      }
      if (!file.patch) {
        skip('binary or diff too large for GitHub to render');
        continue;
      }
      if (file.additions + file.deletions > maxLines) {
        skip(`too large (${file.additions + file.deletions} changed lines > ${maxLines})`);
        continue;
      }
      const headContent = (await gateway.getFileContent(ref, file.filename, pr.headSha)) ?? '';
      headContents.set(file.filename, headContent);
      if (looksGenerated(headContent)) {
        skip('auto-generated (header marker or minified)');
        continue;
      }
      const hunks = parsePatch(file.patch);
      const changed = hunks.flatMap((h) => h.lines.filter((l) => l.type === 'add').map((l) => l.newLine!));
      const totalLines = headContent.split('\n').length;
      const allSymbols = (await extractSymbols(headContent, file.filename)) ?? [];
      const symbols = changed.length ? enclosingSymbols(allSymbols, changed, totalLines) : [];
      prepared.push({
        file,
        hunks,
        headContent,
        symbols,
        commentable: commentableLines(hunks),
        prompt: {
          path: file.filename,
          language: detectLanguage(file.filename) ?? displayLanguage(file.filename),
          numberedDiff: renderNumberedDiff(hunks),
          symbols: symbols.map((s) => ({
            name: s.name,
            kind: s.kind,
            startLine: s.startLine,
            endLine: s.endLine,
            code: sliceLines(headContent, s.startLine, Math.min(s.endLine, s.startLine + MAX_SYMBOL_CONTEXT_LINES - 1)),
          })),
        },
      });
    }

    // 3. Persist file snapshots for the dashboard diff viewer.
    await this.storeFiles(reviewId, ref, pr, files, prepared, skipped, headContents);

    // 4. Acceptance tracking of earlier suggestions on this PR.
    await trackAcceptance(db, pr.id, pr.headSha, headContents, async (path) => {
      if (headContents.has(path)) return headContents.get(path) ?? null;
      const content = await gateway.getFileContent(ref, path, pr.headSha);
      headContents.set(path, content);
      return content;
    });

    const enabledPasses = REVIEW_PASS_IDS.filter((p) => config.passes[p]);
    const finish = async (values: Partial<typeof reviews.$inferInsert>) => {
      await db
        .update(reviews)
        .set({ filesReviewed: prepared.length, filesSkipped: skipped, passes: enabledPasses, completedAt: new Date(), ...values })
        .where(eq(reviews.id, reviewId));
    };

    if (!prepared.length || !enabledPasses.length) {
      const reason = !enabledPasses.length ? 'All review passes are disabled in .codesentinel.yml' : 'No reviewable files in this pull request';
      await finish({ status: 'skipped', skipReason: reason, summary: reason, provider: llm.name, model: llm.model });
      return;
    }

    // 5. Repository context from the embedding index.
    if (!repo.indexedSha) {
      try {
        await this.deps.indexer.indexRepository(repo, pr.baseSha);
      } catch (err) {
        log.warn({ err }, 'repository indexing failed; continuing without related context');
      }
    }
    const related = await this.relatedContext(repo.id, prepared);

    // 6. Token budget: estimate before spending anything.
    const batches = this.batchFiles(prepared, related, repo, pr, skipped);
    if (!batches.length) {
      await finish({ status: 'skipped', skipReason: 'All files exceed the per-review token limit', summary: 'All files exceed the per-review token limit' });
      return;
    }
    const systemTokens = Math.max(...enabledPasses.map((p) => estimateTokens(buildSystemPrompt(PASSES[p], config))));
    const estimate = Math.ceil(batches.reduce((s, b) => s + estimateTokens(b.prompt) + systemTokens, 0) * enabledPasses.length * 1.25);
    const used = await monthlyTokensUsed(db, repo.id);
    if (used + estimate > repo.monthlyTokenBudget) {
      const reason = `Monthly token budget exceeded: ${used.toLocaleString('en-US')} used + ~${estimate.toLocaleString('en-US')} needed > ${repo.monthlyTokenBudget.toLocaleString('en-US')} budget`;
      log.warn({ used, estimate, budget: repo.monthlyTokenBudget }, 'review skipped: token budget');
      await finish({ status: 'skipped', skipReason: reason, summary: reason, provider: llm.name, model: llm.model });
      await gateway
        .createIssueComment(ref, pr.number, `## CodeSentinel review skipped\n\n${reason}. An admin can raise the budget in the dashboard.`)
        .catch((err) => log.warn({ err }, 'failed to post budget notice'));
      return;
    }

    // 7. Multi-pass LLM review (passes x batches, bounded concurrency).
    const jobs = enabledPasses.flatMap((pass) => batches.map((batch) => ({ pass, batch })));
    const passErrors: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let totalCost = 0;
    let model = llm.model;
    const raw = await mapLimit(jobs, options.passConcurrency ?? 4, async ({ pass, batch }) => {
      try {
        const res = await withTimeout(
          llm.complete({
            purpose: `review:${pass}`,
            system: buildSystemPrompt(PASSES[pass], config),
            messages: [{ role: 'user', content: batch.prompt }],
            tools: [reportFindingsTool],
          }),
          options.llmTimeoutMs ?? 120_000,
          `LLM ${pass} pass`,
        );
        const cost = costUsd(res.provider, res.model, res.usage.inputTokens, res.usage.outputTokens);
        inputTokens += res.usage.inputTokens;
        outputTokens += res.usage.outputTokens;
        totalCost += cost;
        model = res.model;
        await db.insert(llmUsage).values({
          repoId: repo.id,
          reviewId,
          purpose: `review:${pass}`,
          provider: res.provider,
          model: res.model,
          inputTokens: res.usage.inputTokens,
          outputTokens: res.usage.outputTokens,
          costUsd: cost,
        });
        const call = res.toolCalls.find((c) => c.name === REPORT_FINDINGS_TOOL);
        const args = parseToolArguments(call?.arguments) as { findings?: unknown[] } | undefined;
        return { pass, files: batch.files, findings: Array.isArray(args?.findings) ? args.findings : [] };
      } catch (err) {
        passErrors.push(`${pass}: ${(err as Error).message}`);
        log.warn({ err, pass }, 'review pass failed');
        return { pass, files: batch.files, findings: [] as unknown[] };
      }
    });
    if (passErrors.length === jobs.length) throw new Error(`All review passes failed: ${passErrors.join('; ')}`);

    // 8. Validate, map to diff lines, filter, dedupe and rank.
    const byPath = new Map(prepared.map((p) => [p.file.filename, p]));
    const candidates: NewFinding[] = [];
    for (const result of raw) {
      for (const item of result.findings) {
        const parsed = rawFindingSchema.safeParse(item);
        if (!parsed.success) continue;
        const f = parsed.data;
        const file = byPath.get(f.file) ?? byPath.get(f.file.replace(/^\.?\//, ''));
        if (!file || !result.files.includes(file.file.filename)) continue;
        const headLines = file.headContent.split('\n');
        if (f.line > headLines.length) continue;
        const endLine = f.end_line && f.end_line > f.line ? Math.min(f.end_line, headLines.length) : null;
        const inDiff = file.commentable.has(f.line) && (endLine === null || file.commentable.has(endLine));
        const symbol = file.symbols.find((s) => s.kind !== 'block' && s.startLine <= f.line && f.line <= s.endLine)?.name ?? null;
        candidates.push({
          reviewId,
          repoId: repo.id,
          pullRequestId: pr.id,
          category: PASSES[result.pass].category,
          severity: f.severity,
          filePath: file.file.filename,
          line: f.line,
          endLine,
          title: f.title,
          explanation: f.explanation,
          suggestion: f.suggestion ?? null,
          ruleId: f.rule_id,
          symbol,
          codeSnippet: headLines.slice(f.line - 1, endLine ?? f.line).join('\n'),
          confidence: f.confidence,
          fingerprint: fingerprintOf(file.file.filename, f.line, f.rule_id !== 'general' ? f.rule_id : f.title),
          inDiff,
        });
      }
    }
    const final = this.filterFindings(candidates, config);

    // 9. Persist and post to GitHub.
    const inserted = final.length ? await db.insert(findingsTable).values(final).returning() : [];
    const inDiff = inserted.filter((f) => f.inDiff);
    const outOfDiff = inserted.filter((f) => !f.inDiff);
    const summary = formatSummary({
      findings: inDiff,
      outOfDiff,
      filesReviewed: prepared.length,
      skipped,
      config,
      configErrors,
      passes: enabledPasses.map((p) => PASSES[p].label),
      usage: { inputTokens, outputTokens, costUsd: totalCost, model },
      dashboardUrl: options.dashboardUrl ? `${options.dashboardUrl.replace(/\/$/, '')}/reviews/${reviewId}` : undefined,
    });

    await finish({
      status: 'completed',
      summary,
      provider: llm.name,
      model,
      inputTokens,
      outputTokens,
      costUsd: Number(totalCost.toFixed(6)),
      error: passErrors.length ? `Some passes failed: ${passErrors.join('; ')}` : null,
    });

    await this.postToGitHub(reviewId, ref, pr, config, inDiff, summary, log);
  }

  private async storeFiles(
    reviewId: string,
    ref: RepoRef,
    pr: PullRequest,
    files: PullRequestFile[],
    prepared: PreparedFile[],
    skipped: SkippedFile[],
    headContents: Map<string, string | null>,
  ) {
    const { db, gateway } = this.deps;
    const rows: (typeof reviewFiles.$inferInsert)[] = [];
    for (const file of files) {
      const prep = prepared.find((p) => p.file.filename === file.filename);
      const skip = skipped.find((s) => s.path === file.filename);
      const counts = file.patch ? countChanges(parsePatch(file.patch)) : { additions: file.additions, deletions: file.deletions };
      const reviewed = Boolean(prep);
      const base = reviewed && file.status !== 'added' ? await gateway.getFileContent(ref, file.previousFilename ?? file.filename, pr.baseSha) : null;
      const head = reviewed ? (headContents.get(file.filename) ?? null) : null;
      rows.push({
        reviewId,
        path: file.filename,
        previousPath: file.previousFilename ?? null,
        status: file.status,
        language: displayLanguage(file.filename),
        additions: counts.additions,
        deletions: counts.deletions,
        patch: file.patch ?? null,
        baseContent: base?.slice(0, MAX_STORED_CONTENT) ?? (reviewed ? '' : null),
        headContent: head?.slice(0, MAX_STORED_CONTENT) ?? null,
        symbols: prep?.symbols.map((s) => ({ name: s.name, kind: s.kind, startLine: s.startLine, endLine: s.endLine })) ?? [],
        skippedReason: skip?.reason ?? null,
      });
    }
    if (rows.length) await db.insert(reviewFiles).values(rows);
  }

  private async relatedContext(repoId: string, prepared: PreparedFile[]): Promise<PromptRelatedChunk[]> {
    const exclude = prepared.map((p) => p.file.filename);
    const seen = new Set<string>();
    const out: PromptRelatedChunk[] = [];
    const queries = prepared.flatMap((p) => p.prompt.symbols.map((s) => s.code)).slice(0, 8);
    for (const q of queries) {
      const hits = await this.deps.indexer.search(repoId, q, { k: 2, excludePaths: exclude, minScore: 0.15 }).catch(() => []);
      for (const h of hits) {
        const key = `${h.path}:${h.startLine}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ path: h.path, symbol: h.symbol, startLine: h.startLine, endLine: h.endLine, content: h.content.slice(0, 1500) });
      }
      if (out.length >= 6) break;
    }
    return out;
  }

  /** Group files into prompts that fit the per-call input token limit. */
  private batchFiles(prepared: PreparedFile[], related: PromptRelatedChunk[], repo: Repository, pr: PullRequest, skipped: SkippedFile[]) {
    const limit = this.deps.options.maxReviewInputTokens;
    const build = (files: PromptFile[], rel: PromptRelatedChunk[]) =>
      buildReviewUserPrompt({ repo: repo.fullName, prNumber: pr.number, prTitle: pr.title, files, related: rel });
    const batches: { files: string[]; prompt: string }[] = [];
    let current: PromptFile[] = [];
    const flush = () => {
      if (!current.length) return;
      const withRelated = build(current, related);
      const prompt = estimateTokens(withRelated) <= limit ? withRelated : build(current, []);
      batches.push({ files: current.map((f) => f.path), prompt });
      current = [];
    };
    for (const p of prepared) {
      let file = p.prompt;
      if (estimateTokens(build([file], [])) > limit) {
        file = { ...file, symbols: file.symbols.map((s) => ({ ...s, code: '' })) }; // drop symbol bodies first
        if (estimateTokens(build([file], [])) > limit) {
          skipped.push({ path: file.path, reason: 'exceeds per-review token limit' });
          continue;
        }
      }
      if (current.length && estimateTokens(build([...current, file], [])) > limit) flush();
      current.push(file);
    }
    flush();
    return batches;
  }

  private filterFindings(candidates: NewFinding[], config: RepoConfig): NewFinding[] {
    const threshold = severityRank(config.severityThreshold);
    const disabled = new Set(config.rules.disabled);
    const byFingerprint = new Map<string, NewFinding>();
    for (const f of candidates) {
      if (severityRank(f.severity) < threshold) continue;
      if (f.ruleId && disabled.has(f.ruleId)) continue;
      const existing = byFingerprint.get(f.fingerprint);
      if (!existing || severityRank(f.severity) > severityRank(existing.severity)) byFingerprint.set(f.fingerprint, f);
    }
    // Same line flagged twice in one category: keep the most severe.
    const byLine = new Map<string, NewFinding>();
    for (const f of byFingerprint.values()) {
      const key = `${f.filePath}:${f.line}:${f.category}`;
      const existing = byLine.get(key);
      if (!existing || severityRank(f.severity) > severityRank(existing.severity)) byLine.set(key, f);
    }
    return [...byLine.values()]
      .sort(
        (a, b) =>
          severityRank(b.severity) - severityRank(a.severity) ||
          (b.confidence ?? 0) - (a.confidence ?? 0) ||
          a.filePath.localeCompare(b.filePath) ||
          a.line - b.line,
      )
      .slice(0, config.maxFindings);
  }

  private async postToGitHub(
    reviewId: string,
    ref: RepoRef,
    pr: PullRequest,
    config: RepoConfig,
    inDiff: { id: string; filePath: string; line: number; endLine: number | null; severity: NewFinding['severity']; category: FindingCategory; title: string; explanation: string; suggestion: string | null; ruleId: string | null; confidence: number }[],
    summary: string,
    log: Logger,
  ) {
    const { db, gateway } = this.deps;
    try {
      const updates: Partial<typeof reviews.$inferInsert> = { postedAt: new Date() };
      if (config.postInlineComments && inDiff.length) {
        const comments: InlineComment[] = inDiff.map((f) => ({
          path: f.filePath,
          line: f.endLine ?? f.line,
          startLine: f.endLine ? f.line : undefined,
          side: 'RIGHT',
          body: formatInlineComment(f),
        }));
        const created = await gateway.createReview(ref, {
          prNumber: pr.number,
          commitSha: pr.headSha,
          body: `CodeSentinel left ${comments.length} inline comment${comments.length === 1 ? '' : 's'}. See the summary comment for an overview.`,
          comments,
        });
        updates.githubReviewId = created.id;
        await Promise.all(
          inDiff.map((f, i) => (created.commentIds[i] ? db.update(findingsTable).set({ githubCommentId: created.commentIds[i] }).where(eq(findingsTable.id, f.id)) : null)),
        );
      }
      if (config.postSummary) {
        const comment = await gateway.createIssueComment(ref, pr.number, summary);
        updates.summaryCommentId = comment.id;
      }
      await db.update(reviews).set(updates).where(eq(reviews.id, reviewId));
    } catch (err) {
      log.warn({ err }, 'failed to post review to GitHub');
      await db
        .update(reviews)
        .set({ error: `Review stored but posting to GitHub failed: ${(err as Error).message}`.slice(0, 2000) })
        .where(and(eq(reviews.id, reviewId), ne(reviews.status, 'failed')));
    }
  }
}

export type { ReviewPassId };
