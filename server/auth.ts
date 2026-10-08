import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import type { Database } from './db/connection';
import { withDatabase } from './db/connection';
import { sessions, users } from './db/schema';
import { SyncError } from './provider';
import type { Account } from '../src/accountTypes';

export const SESSION_COOKIE = 'machun_session';
export const SESSION_SECONDS = 7 * 24 * 60 * 60;
export const hashPassword = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
export const hashToken = hashPassword;
export function readSessionCookie(cookie = ''): string | null {
  const value = cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}
export function sessionCookie(token: string, clear = false): string {
  return `${SESSION_COOKIE}=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : SESSION_SECONDS}`;
}
export class AccountAuth {
  private readonly failures = new Map<string, { count: number; until: number }>();
  constructor(private readonly db: Database, private readonly now: () => number = Date.now) {}
  async login(input: Record<string, unknown>, address: string): Promise<{ user: Account; token: string }> {
    const username = typeof input.username === 'string' ? input.username.trim() : '';
    const password = typeof input.password === 'string' ? input.password : '';
    if (!username || username.length > 64 || !password || password.length > 1024) throw new SyncError('INVALID_REQUEST', '请输入有效的用户名和密码。', 400);
    const key = `${address}:${username}`;
    const failure = this.failures.get(key);
    if (failure && failure.until > this.now() && failure.count >= 5) throw new SyncError('LOGIN_LIMITED', '登录失败次数过多，请 15 分钟后再试。', 429);
    return withDatabase(async () => {
      const [user] = await this.db.select().from(users).where(eq(users.username, username)).limit(1);
      const expected = user?.pwd ?? hashPassword('unknown-account');
      const actual = hashPassword(password);
      const matches = /^[a-f0-9]{64}$/.test(expected) && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
      if (!user || !matches) {
        const latest = this.failures.get(key);
        const previous = latest && latest.until > this.now() ? latest.count : 0;
        this.failures.set(key, { count: previous + 1, until: this.now() + 15 * 60_000 });
        if (this.failures.size > 10_000) for (const [entry, record] of this.failures) if (record.until <= this.now()) this.failures.delete(entry);
        throw new SyncError('BAD_CREDENTIALS', '用户名或密码错误。', 401);
      }
      this.failures.delete(key);
      const token = randomBytes(32).toString('hex');
      await this.db.delete(sessions).where(lt(sessions.expiresAt, new Date(this.now())));
      await this.db.insert(sessions).values({ tokenHash: hashToken(token), username, expiresAt: new Date(this.now() + SESSION_SECONDS * 1000) });
      return { user: { username }, token };
    });
  }
  async account(token: string | null): Promise<Account | null> {
    if (!token) return null;
    return withDatabase(async () => {
      const [session] = await this.db.select({ username: sessions.username }).from(sessions)
        .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date(this.now())))).limit(1);
      return session ? { username: session.username } : null;
    });
  }
  async logout(token: string | null): Promise<void> {
    if (token) await withDatabase(() => this.db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token))).then(() => undefined));
  }
}
