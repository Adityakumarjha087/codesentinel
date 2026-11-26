import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors, jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { ROLE_RANK, type AccessClaims } from './auth/service.js';
import type { Container } from './container.js';
import type { UserRole } from './db/schema.js';
import { AppError, forbidden, unauthorized } from './lib/errors.js';
import { loggerOptions } from './lib/logger.js';
import { authRoutes } from './routes/auth.js';
import { chatRoutes } from './routes/chat.js';
import { findingRoutes } from './routes/findings.js';
import { healthRoutes } from './routes/health.js';
import { repoRoutes } from './routes/repos.js';
import { reviewRoutes } from './routes/reviews.js';
import { statsRoutes } from './routes/stats.js';
import { userRoutes } from './routes/users.js';
import { webhookRoutes } from './routes/webhooks.js';

declare module 'fastify' {
  interface FastifyInstance {
    container: Container;
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (role: UserRole) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    user?: AccessClaims;
  }
}

export type App = FastifyInstance;

export async function buildApp(container: Container): Promise<FastifyInstance> {
  const { env } = container;
  const app = Fastify({
    logger: env.LOG_LEVEL === 'silent' ? false : loggerOptions(env),
    trustProxy: true,
    bodyLimit: 25 * 1024 * 1024, // large PR webhook payloads
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? crypto.randomUUID(),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('container', container);

  await app.register(cors, {
    origin: env.CORS_ORIGINS.split(',').map((o) => o.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    allowList: (req) => req.url.startsWith('/api/health'),
  });

  await app.register(swagger, {
    openapi: {
      info: { title: 'CodeSentinel API', version: '1.0.0', description: 'AI code review GitHub App: webhooks, reviews, findings, analytics and PR chat.' },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
      tags: [
        { name: 'health' },
        { name: 'auth' },
        { name: 'webhooks' },
        { name: 'repositories' },
        { name: 'reviews' },
        { name: 'findings' },
        { name: 'stats' },
        { name: 'chat' },
        { name: 'users' },
      ],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.decorate('authenticate', async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();
    req.user = container.auth.verifyAccessToken(header.slice(7));
  });
  app.decorate('requireRole', (role: UserRole) => async (req: FastifyRequest) => {
    if (!req.user) throw unauthorized();
    if (ROLE_RANK[req.user.role] < ROLE_RANK[role]) throw forbidden(`Requires ${role} role`);
  });

  app.setErrorHandler((error, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.status(400).send({
        error: 'validation_error',
        message: 'Request validation failed',
        details: error.validation.map((v) => ({ path: v.instancePath, message: v.message })),
      });
    }
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: error.code, message: error.message, details: error.details });
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err: error }, 'unhandled error');
    return reply.status(status).send({
      error: status === 429 ? 'rate_limited' : status >= 500 ? 'internal_error' : 'request_error',
      message: status >= 500 ? 'Internal server error' : (error as Error).message,
    });
  });
  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: 'not_found', message: `Route ${req.method} ${req.url} not found` }));

  await app.register(healthRoutes, { prefix: '/api' });
  await app.register(webhookRoutes, { prefix: '/api' });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(repoRoutes, { prefix: '/api' });
  await app.register(reviewRoutes, { prefix: '/api' });
  await app.register(findingRoutes, { prefix: '/api' });
  await app.register(statsRoutes, { prefix: '/api' });
  await app.register(chatRoutes, { prefix: '/api' });
  await app.register(userRoutes, { prefix: '/api' });

  return app;
}
