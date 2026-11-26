import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

export const EMBEDDING_DIMENSIONS = 256;

export const userRole = pgEnum('user_role', ['admin', 'maintainer', 'viewer']);
export const reviewStatus = pgEnum('review_status', ['queued', 'running', 'completed', 'failed', 'skipped']);
export const findingCategory = pgEnum('finding_category', ['bug', 'security', 'performance', 'readability']);
export const findingSeverity = pgEnum('finding_severity', ['info', 'low', 'medium', 'high', 'critical']);
export const findingStatus = pgEnum('finding_status', ['open', 'accepted', 'rejected', 'resolved']);

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  githubId: bigint('github_id', { mode: 'number' }).unique(),
  login: text('login').notNull().unique(),
  name: text('name'),
  email: text('email'),
  avatarUrl: text('avatar_url'),
  role: userRole('role').notNull().default('viewer'),
  createdAt: createdAt(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
});

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    familyId: uuid('family_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('refresh_tokens_user_idx').on(t.userId)],
);

export const installations = pgTable('installations', {
  id: bigint('id', { mode: 'number' }).primaryKey(),
  accountLogin: text('account_login').notNull(),
  accountType: text('account_type').notNull().default('Organization'),
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const repositories = pgTable('repositories', {
  id: uuid('id').primaryKey().defaultRandom(),
  githubId: bigint('github_id', { mode: 'number' }).notNull().unique(),
  installationId: bigint('installation_id', { mode: 'number' }).references(() => installations.id, { onDelete: 'set null' }),
  owner: text('owner').notNull(),
  name: text('name').notNull(),
  fullName: text('full_name').notNull().unique(),
  defaultBranch: text('default_branch').notNull().default('main'),
  private: boolean('private').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  monthlyTokenBudget: integer('monthly_token_budget').notNull().default(2_000_000),
  config: jsonb('config').$type<Record<string, unknown>>(),
  indexedSha: text('indexed_sha'),
  indexedAt: timestamp('indexed_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const pullRequests = pgTable(
  'pull_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    author: text('author').notNull(),
    url: text('url'),
    state: text('state').notNull().default('open'),
    headSha: text('head_sha').notNull(),
    baseSha: text('base_sha').notNull(),
    headRef: text('head_ref').notNull(),
    baseRef: text('base_ref').notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('pull_requests_repo_number_idx').on(t.repoId, t.number)],
);

export type SkippedFile = { path: string; reason: string };

export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    pullRequestId: uuid('pull_request_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    headSha: text('head_sha').notNull(),
    trigger: text('trigger').notNull().default('opened'),
    status: reviewStatus('status').notNull().default('queued'),
    skipReason: text('skip_reason'),
    error: text('error'),
    summary: text('summary'),
    provider: text('provider'),
    model: text('model'),
    filesReviewed: integer('files_reviewed').notNull().default(0),
    filesSkipped: jsonb('files_skipped').$type<SkippedFile[]>().notNull().default([]),
    passes: jsonb('passes').$type<string[]>().notNull().default([]),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    durationMs: integer('duration_ms'),
    githubReviewId: bigint('github_review_id', { mode: 'number' }),
    summaryCommentId: bigint('summary_comment_id', { mode: 'number' }),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    createdAt: createdAt(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [index('reviews_repo_created_idx').on(t.repoId, t.createdAt), index('reviews_pr_idx').on(t.pullRequestId)],
);

export const reviewFiles = pgTable(
  'review_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reviewId: uuid('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    previousPath: text('previous_path'),
    status: text('status').notNull(),
    language: text('language'),
    additions: integer('additions').notNull().default(0),
    deletions: integer('deletions').notNull().default(0),
    patch: text('patch'),
    baseContent: text('base_content'),
    headContent: text('head_content'),
    symbols: jsonb('symbols').$type<{ name: string; kind: string; startLine: number; endLine: number }[]>().notNull().default([]),
    skippedReason: text('skipped_reason'),
  },
  (t) => [index('review_files_review_idx').on(t.reviewId)],
);

export const findings = pgTable(
  'findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reviewId: uuid('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    pullRequestId: uuid('pull_request_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    category: findingCategory('category').notNull(),
    severity: findingSeverity('severity').notNull(),
    filePath: text('file_path').notNull(),
    line: integer('line').notNull(),
    endLine: integer('end_line'),
    title: text('title').notNull(),
    explanation: text('explanation').notNull(),
    suggestion: text('suggestion'),
    ruleId: text('rule_id'),
    symbol: text('symbol'),
    codeSnippet: text('code_snippet'),
    confidence: real('confidence').notNull().default(0.8),
    fingerprint: text('fingerprint').notNull(),
    inDiff: boolean('in_diff').notNull().default(true),
    status: findingStatus('status').notNull().default('open'),
    githubCommentId: bigint('github_comment_id', { mode: 'number' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('findings_review_idx').on(t.reviewId),
    index('findings_repo_created_idx').on(t.repoId, t.createdAt),
    index('findings_pr_status_idx').on(t.pullRequestId, t.status),
  ],
);

export const codeChunks = pgTable(
  'code_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    symbol: text('symbol'),
    kind: text('kind').notNull(),
    startLine: integer('start_line').notNull(),
    endLine: integer('end_line').notNull(),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('code_chunks_repo_path_idx').on(t.repoId, t.path),
    index('code_chunks_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

export const llmUsage = pgTable(
  'llm_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    reviewId: uuid('review_id').references(() => reviews.id, { onDelete: 'set null' }),
    purpose: text('purpose').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    costUsd: doublePrecision('cost_usd').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('llm_usage_repo_created_idx').on(t.repoId, t.createdAt)],
);

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pullRequestId: uuid('pull_request_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    role: text('role').$type<'user' | 'assistant'>().notNull(),
    content: text('content').notNull(),
    sources: jsonb('sources').$type<{ type: string; ref: string; label: string }[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [index('chat_messages_pr_idx').on(t.pullRequestId, t.createdAt)],
);

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: text('id').primaryKey(),
  event: text('event').notNull(),
  action: text('action'),
  status: text('status').notNull(),
  error: text('error'),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().default(sql`now()`),
});

export type User = typeof users.$inferSelect;
export type Repository = typeof repositories.$inferSelect;
export type PullRequest = typeof pullRequests.$inferSelect;
export type Review = typeof reviews.$inferSelect;
export type ReviewFile = typeof reviewFiles.$inferSelect;
export type Finding = typeof findings.$inferSelect;
export type NewFinding = typeof findings.$inferInsert;
export type UserRole = (typeof userRole.enumValues)[number];
export type FindingCategory = (typeof findingCategory.enumValues)[number];
export type FindingSeverity = (typeof findingSeverity.enumValues)[number];
export type FindingStatus = (typeof findingStatus.enumValues)[number];
