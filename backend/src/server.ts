import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createContainer } from './container.js';

const env = loadEnv();
const container = await createContainer(env);
const app = await buildApp(container);

if (env.RUN_WORKER) {
  await container.queue.startWorker((job) => container.handleJob(job), env.WORKER_CONCURRENCY);
  app.log.info({ queue: container.queue.kind }, 'in-process worker started');
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await container.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: env.HOST, port: env.PORT });
app.log.info({ llm: container.llm.name, github: container.gateway.mode }, `CodeSentinel API listening on ${env.HOST}:${env.PORT}`);
