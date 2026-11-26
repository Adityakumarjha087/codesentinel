import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { pullRequests } from '../db/schema.js';
import { notFound } from '../lib/errors.js';

const secured = [{ bearerAuth: [] }];
const params = z.object({ id: z.uuid() });

export const chatRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db, chat } = app.container;
  app.addHook('preHandler', app.authenticate);

  app.get('/pull-requests/:id/chat', { schema: { tags: ['chat'], summary: 'PR chat history', params, security: secured } }, async (req) => {
    const [pr] = await db.select({ id: pullRequests.id }).from(pullRequests).where(eq(pullRequests.id, req.params.id));
    if (!pr) throw notFound('Pull request');
    return chat.history(pr.id);
  });

  app.post(
    '/pull-requests/:id/chat',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['chat'],
        summary: 'Ask a follow-up question about a pull request',
        params,
        security: secured,
        body: z.object({ message: z.string().trim().min(1).max(2000) }),
      },
    },
    async (req) => chat.ask(req.params.id, req.user!.sub, req.body.message),
  );
};
