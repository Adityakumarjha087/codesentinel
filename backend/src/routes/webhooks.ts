import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { verifySignature } from '../github/signature.js';
import { unauthorized } from '../lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export const webhookRoutes: FastifyPluginAsyncZod = async (app) => {
  // Keep the exact bytes: the HMAC must be computed over the raw payload, not re-serialized JSON.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body as Buffer;
    try {
      done(null, (body as Buffer).length ? JSON.parse((body as Buffer).toString('utf8')) : {});
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  app.post(
    '/webhooks/github',
    {
      config: { rateLimit: { max: 2000, timeWindow: '1 minute' } },
      schema: {
        tags: ['webhooks'],
        summary: 'GitHub App webhook receiver (HMAC-SHA256 verified)',
        headers: z
          .object({
            'x-github-event': z.string().min(1),
            'x-github-delivery': z.string().optional(),
            'x-hub-signature-256': z.string().optional(),
          })
          .loose(),
        response: {
          202: z.object({ status: z.string(), reason: z.string().optional(), reviewId: z.string().optional() }),
        },
      },
    },
    async (req, reply) => {
      const { env, webhooks } = app.container;
      if (!verifySignature(env.GITHUB_WEBHOOK_SECRET, req.rawBody ?? Buffer.alloc(0), req.headers['x-hub-signature-256'])) {
        req.log.warn({ delivery: req.headers['x-github-delivery'] }, 'webhook signature verification failed');
        throw unauthorized('Invalid webhook signature');
      }
      const result = await webhooks.handle(req.headers['x-github-event'], req.headers['x-github-delivery'], req.body);
      return reply.status(202).send(result);
    },
  );
};
