import { loadEnv } from './config/env.js';
import { createContainer } from './container.js';

/** Dedicated queue consumer (docker-compose `worker` service). */
const env = loadEnv();
const container = await createContainer(env);
await container.queue.startWorker((job) => container.handleJob(job), env.WORKER_CONCURRENCY);
container.logger.info({ queue: container.queue.kind, concurrency: env.WORKER_CONCURRENCY, llm: container.llm.name }, 'worker started');

const shutdown = async () => {
  await container.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
