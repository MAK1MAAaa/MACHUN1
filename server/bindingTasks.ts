import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, inArray, lt } from 'drizzle-orm';
import type { BindingSubmission, BindingTask, CompanionTask, CreatedBindingTask } from '../src/sourceBindingTypes';
import type { BrowserSource, SourceIdentity } from '../src/syncTypes';
import type { Database } from './db/connection';
import { withDatabase } from './db/connection';
import { bindingTasks, sessions, sourceStates } from './db/schema';
import { hashToken } from './auth';
import { safeError, type SourceManager } from './manager';
import { SyncError } from './provider';
import { PORTAL_ORIGINS, validatePortableSession } from './portableSession';

type TaskRow = typeof bindingTasks.$inferSelect;
const ACTIVE = ['pending', 'validating'] as const;
const EXPIRED = '绑定任务已取消或过期，请在网页重新生成。';
function identity(input: unknown): SourceIdentity {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SyncError('INVALID_REQUEST', '绑定身份格式无效。', 400);
  const data = input as Record<string, unknown>;
  for (const key of ['id', 'label', 'cardId']) if (data[key] !== undefined && (typeof data[key] !== 'string' || !(data[key] as string).trim() || (data[key] as string).length > 256)) throw new SyncError('INVALID_REQUEST', '绑定身份格式无效。', 400);
  if (!data.id || !data.label) throw new SyncError('INVALID_REQUEST', '绑定身份格式无效。', 400);
  return { id: data.id as string, label: data.label as string, ...(data.cardId ? { cardId: data.cardId as string } : {}) };
}
export class BindingTaskService {
  private readonly running = new Map<string, { abort: AbortController; work: Promise<void> }>();
  constructor(private readonly db: Database, private readonly manager: (username: string) => Promise<SourceManager>,
    private readonly now: () => number = Date.now, private readonly bootId = randomUUID()) {}

  private view(row: TaskRow): BindingTask {
    return { id: row.id, source: row.source, status: row.status, expiresAt: row.expiresAt.toISOString(), error: row.error };
  }
  private async read(id: string, owner: { username: string } | { code: string }): Promise<TaskRow> {
    let [row] = await withDatabase(() => this.db.select().from(bindingTasks).where(eq(bindingTasks.id, id)));
    if (!row || ('username' in owner && row.username !== owner.username)) throw new SyncError('NOT_FOUND', '绑定任务不存在。', 404);
    if ('code' in owner) {
      const hashed = hashToken(owner.code);
      if (!/^[A-Za-z0-9_-]{43}$/.test(owner.code) || !timingSafeEqual(Buffer.from(hashed, 'hex'), Buffer.from(row.codeHash, 'hex'))) throw new SyncError('INVALID_BINDING_CODE', '绑定码无效。', 401);
    }
    if (ACTIVE.includes(row.status as typeof ACTIVE[number])) {
      const [session] = await withDatabase(() => this.db.select().from(sessions).where(and(eq(sessions.tokenHash, row.sessionHash), gt(sessions.expiresAt, new Date(this.now())))));
      if (row.bootId !== this.bootId || row.expiresAt.getTime() <= this.now() || !session) {
        await withDatabase(() => this.db.update(bindingTasks).set({ status: 'expired', error: EXPIRED }).where(and(eq(bindingTasks.id, id), inArray(bindingTasks.status, [...ACTIVE]))));
        const [current] = await withDatabase(() => this.db.select().from(bindingTasks).where(eq(bindingTasks.id, id)));
        // A final commit may have won the expiry race; report the database outcome.
        row = current ?? row;
        if (row.status === 'expired') this.running.get(id)?.abort.abort();
      }
    }
    return row;
  }
  async create(username: string, source: BrowserSource, sessionToken: string): Promise<CreatedBindingTask> {
    const manager = await this.manager(username);
    const connection = manager.connections().find(item => item.source === source)!;
    if (connection.status === 'syncing' || connection.status === 'binding') throw new SyncError('BUSY', '该来源正在处理，请等待完成。', 409);
    const code = randomBytes(32).toString('base64url');
    const row: TaskRow = { id: randomUUID(), username, source, codeHash: hashToken(code), sessionHash: hashToken(sessionToken),
      bootId: this.bootId, status: 'pending', expiresAt: new Date(this.now() + 10 * 60_000), error: null };
    await this.cancelFor(username, source);
    await withDatabase(() => this.db.transaction(async tx => {
      // Serialize replacement codes created from the same web session.
      await tx.select().from(sessions).where(eq(sessions.tokenHash, row.sessionHash)).for('update');
      const [valid] = await tx.select().from(sessions).where(and(eq(sessions.tokenHash, row.sessionHash), gt(sessions.expiresAt, new Date(this.now()))));
      if (!valid || valid.username !== username) throw new SyncError('UNAUTHORIZED', '请先登录。', 401);
      await tx.update(bindingTasks).set({ status: 'cancelled', error: EXPIRED }).where(and(eq(bindingTasks.username, username), eq(bindingTasks.source, source), inArray(bindingTasks.status, [...ACTIVE])));
      await tx.delete(bindingTasks).where(lt(bindingTasks.expiresAt, new Date(this.now() - 86400_000)));
      await tx.insert(bindingTasks).values(row);
    }));
    return { ...this.view(row), code };
  }
  async get(username: string, id: string): Promise<BindingTask> { return this.view(await this.read(id, { username })); }
  async companion(id: string, code: string): Promise<CompanionTask> {
    const row = await this.read(id, { code });
    return { ...this.view(row), loginUrl: `${PORTAL_ORIGINS[row.source]}/${row.source === 'munet' ? 'user' : ''}` };
  }
  async cancel(username: string, id: string): Promise<BindingTask> {
    await this.read(id, { username });
    await withDatabase(() => this.db.update(bindingTasks).set({ status: 'cancelled', error: EXPIRED }).where(and(eq(bindingTasks.id, id), inArray(bindingTasks.status, [...ACTIVE]))));
    this.running.get(id)?.abort.abort();
    return this.get(username, id);
  }
  async cancelFor(username: string, source?: BrowserSource, sessionToken?: string): Promise<void> {
    const condition = and(eq(bindingTasks.username, username), inArray(bindingTasks.status, [...ACTIVE]),
      source ? eq(bindingTasks.source, source) : undefined, sessionToken ? eq(bindingTasks.sessionHash, hashToken(sessionToken)) : undefined);
    const rows = await withDatabase(() => this.db.select().from(bindingTasks).where(condition));
    await withDatabase(() => this.db.update(bindingTasks).set({ status: 'cancelled', error: EXPIRED }).where(condition));
    for (const row of rows) this.running.get(row.id)?.abort.abort();
  }
  async submit(id: string, code: string, input: Record<string, unknown>): Promise<BindingTask> {
    const row = await this.read(id, { code });
    const submission: BindingSubmission = { session: validatePortableSession(row.source, input.session), identity: identity(input.identity) };
    await withDatabase(() => this.db.transaction(async tx => {
      const [current] = await tx.select().from(bindingTasks).where(eq(bindingTasks.id, id)).for('update');
      if (current?.status !== 'pending') throw new SyncError('TASK_USED', '该任务已提交或失效，请查询任务结果。', 409);
      await tx.update(bindingTasks).set({ status: 'validating' }).where(eq(bindingTasks.id, id));
    }));
    const abort = new AbortController();
    const work = Promise.resolve().then(async () => {
      try {
        const manager = await this.manager(row.username);
        await manager.bindPortable(row.source, submission.session, submission.identity, async state => {
          await withDatabase(() => this.db.transaction(async tx => {
            // Logout, cancellation and replacing a code race against this same commit.
            const [session] = await tx.select().from(sessions).where(eq(sessions.tokenHash, row.sessionHash)).for('update');
            const [current] = await tx.select().from(bindingTasks).where(eq(bindingTasks.id, id)).for('update');
            if (!session || session.expiresAt.getTime() <= this.now() || current?.status !== 'validating'
              || current.bootId !== this.bootId || current.expiresAt.getTime() <= this.now() || abort.signal.aborted) throw new SyncError('TASK_CANCELLED', EXPIRED, 409);
            await tx.insert(sourceStates).values({ username: row.username, source: row.source, state }).onDuplicateKeyUpdate({ set: { state } });
            await tx.update(bindingTasks).set({ status: 'complete', error: null }).where(eq(bindingTasks.id, id));
          }));
        }, abort.signal);
      } catch (error) {
        const safe = safeError(error);
        await withDatabase(() => this.db.update(bindingTasks).set({ status: 'failed', error: safe.message.slice(0, 512) }).where(and(eq(bindingTasks.id, id), eq(bindingTasks.status, 'validating')))).catch(() => undefined);
      } finally { this.running.delete(id); }
    });
    this.running.set(id, { abort, work });
    return { ...this.view(row), status: 'validating' };
  }
  async close(): Promise<void> {
    for (const task of this.running.values()) task.abort.abort();
    await Promise.allSettled([...this.running.values()].map(task => task.work));
  }
}
