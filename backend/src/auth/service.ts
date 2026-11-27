import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, count, eq, isNull } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import type { Database } from '../db/client.js';
import { refreshTokens, users, type User, type UserRole } from '../db/schema.js';
import { unauthorized } from '../lib/errors.js';

export interface AccessClaims {
  sub: string;
  login: string;
  role: UserRole;
}

export interface AuthServiceOptions {
  jwtSecret: string;
  accessTtlSeconds: number;
  refreshTtlDays: number;
  adminLogins: string[];
  /** When true, devLogin never creates users or changes roles (safe for public demos). */
  devLoginExistingOnly?: boolean;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: PublicUser;
}

export type PublicUser = Pick<User, 'id' | 'login' | 'name' | 'avatarUrl' | 'role'>;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export const toPublicUser = (u: User): PublicUser => ({ id: u.id, login: u.login, name: u.name, avatarUrl: u.avatarUrl, role: u.role });

export const ROLE_RANK: Record<UserRole, number> = { viewer: 0, maintainer: 1, admin: 2 };

export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly opts: AuthServiceOptions,
  ) {}

  signAccessToken(user: Pick<User, 'id' | 'login' | 'role'>): string {
    const claims: AccessClaims = { sub: user.id, login: user.login, role: user.role };
    return jwt.sign(claims, this.opts.jwtSecret, { expiresIn: this.opts.accessTtlSeconds, issuer: 'codesentinel', audience: 'codesentinel-api' });
  }

  verifyAccessToken(token: string): AccessClaims {
    try {
      const decoded = jwt.verify(token, this.opts.jwtSecret, { issuer: 'codesentinel', audience: 'codesentinel-api' }) as jwt.JwtPayload & AccessClaims;
      return { sub: decoded.sub, login: decoded.login, role: decoded.role };
    } catch {
      throw unauthorized('Invalid or expired access token');
    }
  }

  async issueTokens(user: User, familyId: string = randomUUID()): Promise<IssuedTokens> {
    const refreshToken = randomBytes(48).toString('base64url');
    await this.db.insert(refreshTokens).values({
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      familyId,
      expiresAt: new Date(Date.now() + this.opts.refreshTtlDays * 86_400_000),
    });
    return { accessToken: this.signAccessToken(user), refreshToken, expiresIn: this.opts.accessTtlSeconds, user: toPublicUser(user) };
  }

  /** Rotate a refresh token. Re-use of a revoked token revokes the whole token family (theft detection). */
  async rotate(refreshToken: string): Promise<IssuedTokens> {
    const [record] = await this.db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, hashToken(refreshToken)));
    if (!record) throw unauthorized('Unknown refresh token');
    if (record.revokedAt) {
      await this.db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.familyId, record.familyId), isNull(refreshTokens.revokedAt)));
      throw unauthorized('Refresh token reuse detected; please sign in again');
    }
    if (record.expiresAt.getTime() < Date.now()) throw unauthorized('Refresh token expired');
    // Atomic claim: only one concurrent rotation of the same token can succeed.
    const claimed = await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.id, record.id), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id });
    if (!claimed.length) throw unauthorized('Refresh token already used');
    const [user] = await this.db.select().from(users).where(eq(users.id, record.userId));
    if (!user) throw unauthorized('User no longer exists');
    return this.issueTokens(user, record.familyId);
  }

  async revoke(refreshToken: string): Promise<void> {
    await this.db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.tokenHash, hashToken(refreshToken)));
  }

  private async roleForNewUser(login: string): Promise<UserRole> {
    if (this.opts.adminLogins.map((l) => l.toLowerCase()).includes(login.toLowerCase())) return 'admin';
    const [row] = await this.db.select({ n: count() }).from(users);
    return Number(row?.n ?? 0) === 0 ? 'admin' : 'viewer';
  }

  async upsertGithubUser(profile: { id: number; login: string; name?: string | null; email?: string | null; avatar_url?: string | null }): Promise<User> {
    const [existing] = await this.db.select().from(users).where(eq(users.githubId, profile.id));
    const values = { login: profile.login, name: profile.name ?? null, email: profile.email ?? null, avatarUrl: profile.avatar_url ?? null, lastLoginAt: new Date() };
    if (existing) {
      const [updated] = await this.db.update(users).set(values).where(eq(users.id, existing.id)).returning();
      return updated!;
    }
    const [created] = await this.db
      .insert(users)
      .values({ ...values, githubId: profile.id, role: await this.roleForNewUser(profile.login) })
      .returning();
    return created!;
  }

  /**
   * Development-only login (AUTH_DEV_LOGIN=true): creates or updates a local user with the given role.
   * With devLoginExistingOnly, only existing users can sign in and their stored role is kept.
   */
  async devLogin(login: string, role: UserRole): Promise<User> {
    if (this.opts.devLoginExistingOnly) {
      const [existing] = await this.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.login, login)).returning();
      if (!existing) throw unauthorized('Unknown demo user');
      return existing;
    }
    const [user] = await this.db
      .insert(users)
      .values({ login, name: login.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), role, lastLoginAt: new Date(), avatarUrl: null })
      .onConflictDoUpdate({ target: users.login, set: { role, lastLoginAt: new Date() } })
      .returning();
    return user!;
  }

  async getUser(id: string): Promise<User | undefined> {
    const [user] = await this.db.select().from(users).where(eq(users.id, id));
    return user;
  }
}
