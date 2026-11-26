import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

const healthResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  uptimeSeconds: z.number(),
  checks: z.object({ database: z.boolean(), queue: z.boolean() }),
  llm: z.object({ provider: z.string(), model: z.string() }),
  embeddings: z.string(),
  github: z.enum(['mock', 'live']),
  queue: z.enum(['bullmq', 'inline']),
});

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/health',
    { schema: { tags: ['health'], summary: 'Liveness/readiness probe', response: { 200: healthResponse, 503: healthResponse } } },
    async (_req, reply) => {
      const { dbHandle, queue, llm, embedder, gateway } = app.container;
      const [database, queueOk] = await Promise.all([dbHandle.ping().catch(() => false), queue.ping().catch(() => false)]);
      const body = {
        status: database && queueOk ? ('ok' as const) : ('degraded' as const),
        version: '1.0.0',
        uptimeSeconds: Math.round(process.uptime()),
        checks: { database, queue: queueOk },
        llm: { provider: llm.name, model: llm.model },
        embeddings: embedder.name,
        github: gateway.mode,
        queue: queue.kind,
      };
      return reply.status(body.status === 'ok' ? 200 : 503).send(body);
    },
  );
};
