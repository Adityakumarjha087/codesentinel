import { eq } from 'drizzle-orm';
import { AuthService } from './auth/service.js';
import { GitHubOAuth } from './auth/github-oauth.js';
import { PrChatService } from './chat/service.js';
import type { Env } from './config/env.js';
import { createDatabase, type Database, type DatabaseHandle } from './db/client.js';
import { repositories } from './db/schema.js';
import { createEmbedder, type Embedder } from './embeddings/index.js';
import { MockGitHubGateway } from './github/mock-gateway.js';
import { OctokitGateway } from './github/octokit-gateway.js';
import type { GitHubGateway } from './github/types.js';
import { WebhookService } from './github/webhook-service.js';
import { RepositoryIndexer } from './indexing/indexer.js';
import { createLogger, type Logger } from './lib/logger.js';
import { createLlmProvider, type FetchLike, type LlmProvider } from './llm/index.js';
import { BullMqQueue, InlineQueue, redisConnection, type Job, type JobQueue } from './queue/index.js';
import { ReviewEngine } from './review/engine.js';

export interface Container {
  env: Env;
  logger: Logger;
  dbHandle: DatabaseHandle;
  db: Database;
  gateway: GitHubGateway;
  llm: LlmProvider;
  embedder: Embedder;
  indexer: RepositoryIndexer;
  engine: ReviewEngine;
  queue: JobQueue;
  webhooks: WebhookService;
  chat: PrChatService;
  auth: AuthService;
  oauth: GitHubOAuth;
  handleJob(job: Job): Promise<void>;
  close(): Promise<void>;
}

export interface ContainerOverrides {
  logger?: Logger;
  dbHandle?: DatabaseHandle;
  gateway?: GitHubGateway;
  llm?: LlmProvider;
  embedder?: Embedder;
  queue?: JobQueue;
  fetch?: FetchLike;
}

export async function createContainer(env: Env, overrides: ContainerOverrides = {}): Promise<Container> {
  const logger = overrides.logger ?? createLogger(env);
  const dbHandle = overrides.dbHandle ?? (await createDatabase({ driver: env.DATABASE_DRIVER, url: env.DATABASE_URL }));
  if (env.AUTO_MIGRATE && !overrides.dbHandle) await dbHandle.migrate();
  const db = dbHandle.db;

  const gateway =
    overrides.gateway ??
    (env.GITHUB_MODE === 'live'
      ? new OctokitGateway({ appId: env.GITHUB_APP_ID!, privateKey: env.GITHUB_PRIVATE_KEY!.replace(/\\n/g, '\n'), baseUrl: env.GITHUB_API_URL })
      : new MockGitHubGateway());
  const llm = overrides.llm ?? createLlmProvider(env, overrides.fetch);
  const embedder = overrides.embedder ?? createEmbedder(env, overrides.fetch);
  const indexer = new RepositoryIndexer(db, gateway, embedder, logger, env.MAX_INDEX_FILES);
  const engine = new ReviewEngine({
    db,
    gateway,
    llm,
    indexer,
    logger,
    options: { maxFileChangedLines: env.MAX_FILE_CHANGED_LINES, maxReviewInputTokens: env.MAX_REVIEW_INPUT_TOKENS, dashboardUrl: env.FRONTEND_URL },
  });
  const queue = overrides.queue ?? (env.QUEUE_MODE === 'bullmq' ? new BullMqQueue(redisConnection(env.REDIS_URL!), logger) : new InlineQueue(logger));
  const webhooks = new WebhookService(db, queue, logger, env.DEFAULT_MONTHLY_TOKEN_BUDGET);
  const chat = new PrChatService(db, llm, indexer);
  const auth = new AuthService(db, {
    jwtSecret: env.JWT_SECRET,
    accessTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
    refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
    adminLogins: env.ADMIN_GITHUB_LOGINS.split(',').map((s) => s.trim()).filter(Boolean),
  });
  const oauth = new GitHubOAuth({
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    callbackUrl: env.GITHUB_OAUTH_CALLBACK_URL,
    webUrl: env.GITHUB_WEB_URL,
    apiUrl: env.GITHUB_API_URL,
    fetch: overrides.fetch,
  });

  const handleJob = async (job: Job) => {
    if (job.type === 'review') return engine.run(job.reviewId);
    const [repo] = await db.select().from(repositories).where(eq(repositories.id, job.repoId));
    if (!repo) return;
    await indexer.indexRepository(repo, job.ref ?? repo.defaultBranch);
  };

  return {
    env,
    logger,
    dbHandle,
    db,
    gateway,
    llm,
    embedder,
    indexer,
    engine,
    queue,
    webhooks,
    chat,
    auth,
    oauth,
    handleJob,
    async close() {
      await queue.close();
      await dbHandle.close();
    },
  };
}
