import { randomBytes } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { toPublicUser, type IssuedTokens } from '../auth/service.js';
import { AppError, notFound, unauthorized } from '../lib/errors.js';

const REFRESH_COOKIE = 'cs_refresh';
const STATE_COOKIE = 'cs_oauth_state';

const userSchema = z.object({
  id: z.string(),
  login: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  role: z.enum(['admin', 'maintainer', 'viewer']),
});
const tokenResponse = z.object({ accessToken: z.string(), expiresIn: z.number(), user: userSchema });

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const { env, auth, oauth } = app.container;
  const cookieOpts = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: env.COOKIE_SECURE,
    path: '/api/auth',
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400,
  };
  const sendTokens = (reply: FastifyReply, tokens: IssuedTokens) => {
    reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, cookieOpts);
    return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn, user: tokens.user };
  };

  app.get(
    '/config',
    { schema: { tags: ['auth'], summary: 'Available login methods', response: { 200: z.object({ githubOAuth: z.boolean(), devLogin: z.boolean() }) } } },
    async () => ({ githubOAuth: oauth.enabled, devLogin: env.AUTH_DEV_LOGIN }),
  );

  app.post(
    '/dev-login',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['auth'],
        summary: 'Local demo login (only when AUTH_DEV_LOGIN=true)',
        body: z
          .object({
            login: z.string().regex(/^[a-zA-Z0-9-_]{2,39}$/).default('demo-admin'),
            role: z.enum(['admin', 'maintainer', 'viewer']).default('admin'),
          })
          .default({ login: 'demo-admin', role: 'admin' }),
        response: { 200: tokenResponse },
      },
    },
    async (req, reply) => {
      if (!env.AUTH_DEV_LOGIN) throw notFound('Route');
      const user = await auth.devLogin(req.body.login, req.body.role);
      return sendTokens(reply, await auth.issueTokens(user));
    },
  );

  app.get('/github/login', { schema: { tags: ['auth'], summary: 'Start GitHub OAuth login' } }, async (_req, reply) => {
    if (!oauth.enabled) throw new AppError(404, 'oauth_disabled', 'GitHub OAuth is not configured');
    const state = randomBytes(16).toString('hex');
    reply.setCookie(STATE_COOKIE, state, { ...cookieOpts, maxAge: 600 });
    return reply.redirect(oauth.authorizeUrl(state));
  });

  app.get(
    '/github/callback',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: { tags: ['auth'], summary: 'GitHub OAuth callback', querystring: z.object({ code: z.string().min(1), state: z.string().min(1) }) },
    },
    async (req, reply) => {
      const expected = req.cookies[STATE_COOKIE];
      if (!expected || expected !== req.query.state) throw unauthorized('OAuth state mismatch');
      reply.clearCookie(STATE_COOKIE, { path: cookieOpts.path });
      const token = await oauth.exchangeCode(req.query.code);
      const profile = await oauth.fetchProfile(token);
      const user = await auth.upsertGithubUser(profile);
      const tokens = await auth.issueTokens(user);
      reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, cookieOpts);
      return reply.redirect(`${env.FRONTEND_URL.replace(/\/$/, '')}/`);
    },
  );

  app.post(
    '/refresh',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } }, schema: { tags: ['auth'], summary: 'Rotate refresh token (httpOnly cookie)', response: { 200: tokenResponse } } },
    async (req, reply) => {
      const token = req.cookies[REFRESH_COOKIE];
      if (!token) throw unauthorized('No refresh token');
      try {
        return sendTokens(reply, await auth.rotate(token));
      } catch (err) {
        reply.clearCookie(REFRESH_COOKIE, { path: cookieOpts.path });
        throw err;
      }
    },
  );

  app.post('/logout', { schema: { tags: ['auth'], summary: 'Revoke refresh token' } }, async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (token) await auth.revoke(token);
    reply.clearCookie(REFRESH_COOKIE, { path: cookieOpts.path });
    return reply.status(204).send();
  });

  app.get(
    '/me',
    { preHandler: app.authenticate, schema: { tags: ['auth'], summary: 'Current user', security: [{ bearerAuth: [] }], response: { 200: userSchema } } },
    async (req) => {
      const user = await auth.getUser(req.user!.sub);
      if (!user) throw unauthorized('User no longer exists');
      return toPublicUser(user);
    },
  );
};
