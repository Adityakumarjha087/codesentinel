import { asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { toPublicUser } from '../auth/service.js';
import { users } from '../db/schema.js';
import { badRequest, notFound } from '../lib/errors.js';

const secured = [{ bearerAuth: [] }];

export const userRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app.container;
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.requireRole('admin'));

  app.get('/users', { schema: { tags: ['users'], summary: 'List users (admin)', security: secured } }, async () => {
    const rows = await db.select().from(users).orderBy(asc(users.createdAt));
    return rows.map((u) => ({ ...toPublicUser(u), createdAt: u.createdAt, lastLoginAt: u.lastLoginAt }));
  });

  app.patch(
    '/users/:id',
    {
      schema: {
        tags: ['users'],
        summary: 'Change a user role (admin)',
        security: secured,
        params: z.object({ id: z.uuid() }),
        body: z.object({ role: z.enum(['admin', 'maintainer', 'viewer']) }),
      },
    },
    async (req) => {
      if (req.params.id === req.user!.sub && req.body.role !== 'admin') throw badRequest('Admins cannot demote themselves');
      const [updated] = await db.update(users).set({ role: req.body.role }).where(eq(users.id, req.params.id)).returning();
      if (!updated) throw notFound('User');
      return toPublicUser(updated);
    },
  );
};
