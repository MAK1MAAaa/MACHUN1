import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { prepareTestDatabase } from '../scripts/mysql-test-fixture';
import { AccountAuth, hashPassword, hashToken, SESSION_SECONDS } from './auth';
import { AccountService, MysqlSourceStore } from './accountService';
import { SourceStore } from './store';
import { SourceManager } from './manager';
import { BindingTaskService } from './bindingTasks';
import type { SavedSource } from './store';
import { SyncError } from './provider';
import { WorkspaceRepository } from './workspace';
import { loadCatalog } from './db/catalog';
import { sessions, users, scores, workspaces, sourceStates, bindingTasks } from './db/schema';
import { catalog, catalogByKey } from '../src/core/catalog';
import { EMPTY_STATE } from '../src/core/storage';
import { calculateRating } from '../src/core/rating';
import { createFullBackup } from '../src/core/backup';
import { createB30Export } from '../src/core/b30Export';
import type { SingleRating } from '../src/types';
import type { SyncResult } from '../src/syncTypes';
import { createAppServer } from './http';
import type { BrowserProvider } from './provider';
import * as browserModule from './browser';

const enabled = Boolean(process.env.MACHUN_TEST_ADMIN_URL);
describe.skipIf(!enabled)('isolated MySQL persistence and accounts', () => {
  let fixture: Awaited<ReturnType<typeof prepareTestDatabase>>;
  let directory: string;
  let auth: AccountAuth;
  let repository: WorkspaceRepository;
  const first = catalog[0]; const key = `${first.id}:${first.difficulty}`;
  const record = (score: number, source: SingleRating['source'] = 'rin'): SingleRating => ({ ...first,
    score, source, rating: 999, updatedAt: '2026-10-08T10:00:00.000Z', combo: 'aj', fullChain: 'platinum' });
  const sync = (score: number, source: SyncResult['source'] = 'rin'): SyncResult => ({ source, records: [record(score, source)],
    report: { parsedScores: 1, importedScores: 1, updatedScores: 0, skippedScores: 0, unknownCharts: 0, invalidEntries: 0 },
    connection: { source, bound: true, status: 'ready', identity: { id: 'fixture', label: '测试' }, lastAttemptAt: null, lastSuccessAt: null, error: null } });
  beforeAll(async () => {
    fixture = await prepareTestDatabase();
    directory = await mkdtemp(join(tmpdir(), 'machun-isolation-'));
    auth = new AccountAuth(fixture.db); repository = new WorkspaceRepository(fixture.db);
    await fixture.db.insert(users).values([{ username: 'alice', pwd: hashPassword('alice-pwd') }, { username: 'Alice', pwd: hashPassword('upper-pwd') }]);
  }, 30_000);
  afterAll(async () => {
    if (fixture) { await fixture.pool.end(); await fixture.admin.end(); }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('creates exactly two user columns, case-sensitive usernames, and a CRUD-only application connection', async () => {
    const [columns] = await fixture.admin.query('SHOW COLUMNS FROM machun1.users');
    expect((columns as { Field: string }[]).map(row => row.Field)).toEqual(['username', 'pwd']);
    expect((await fixture.db.select().from(users).where(eq(users.username, 'root')))[0].pwd).toBe(hashPassword('pwd'));
    expect((await fixture.db.select().from(users).where(eq(users.username, 'ROOT')))).toEqual([]);
    await expect(fixture.pool.query('CREATE TABLE machun1.unexpected (id INT)')).rejects.toMatchObject({ code: 'ER_TABLEACCESS_DENIED_ERROR' });
    await fixture.admin.query('SELECT 1');
  });
  it('repeating migrations preserves an existing password and catalogue aliases/details', async () => {
    await fixture.db.update(users).set({ pwd: hashPassword('changed') }).where(eq(users.username, 'Alice'));
    await fixture.admin.query(fixture.migration);
    await fixture.admin.execute('INSERT IGNORE INTO machun1.users (username,pwd) VALUES (?,?)', ['Alice', hashPassword('pwd')]);
    expect((await fixture.db.select().from(users).where(eq(users.username, 'Alice')))[0].pwd).toBe(hashPassword('changed'));
    const snapshot = await loadCatalog(fixture.db);
    expect(snapshot.charts).toEqual(catalog);
    expect(snapshot.details).toEqual(expect.arrayContaining([{ id: '3055', difficulty: 'EXP', constant: 12.5 }, { id: '3064', difficulty: 'EXP', constant: 11.9 }, { id: '3062', difficulty: 'EXP', constant: 11.3 }]));
  });
  it('authenticates, hashes session tokens, expires after seven days and revokes logout', async () => {
    const login = await auth.login({ username: 'root', password: 'pwd' }, 'success');
    expect(login.user).toEqual({ username: 'root' });
    expect(await auth.account(login.token)).toEqual(login.user);
    const [row] = await fixture.db.select().from(sessions).where(eq(sessions.tokenHash, hashToken(login.token)));
    expect(row.tokenHash).not.toBe(login.token);
    expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan((SESSION_SECONDS - 10) * 1000);
    const future = new AccountAuth(fixture.db, () => Date.now() + (SESSION_SECONDS + 1) * 1000);
    expect(await future.account(login.token)).toBeNull();
    await auth.logout(login.token); expect(await auth.account(login.token)).toBeNull();
  });
  it('uses the same credential failure, limits repeated attempts, and keeps usernames case-sensitive', async () => {
    for (const input of [{ username: 'ROOT', password: 'pwd' }, { username: 'root', password: 'wrong' }]) {
      await expect(auth.login(input, 'bad')).rejects.toMatchObject({ code: 'BAD_CREDENTIALS', message: '用户名或密码错误。' });
    }
    for (let i = 0; i < 5; i++) await expect(auth.login({ username: 'unknown', password: 'pwd' }, 'limited')).rejects.toMatchObject({ code: 'BAD_CREDENTIALS' });
    await expect(auth.login({ username: 'unknown', password: 'pwd' }, 'limited')).rejects.toMatchObject({ code: 'LOGIN_LIMITED', status: 429 });
    await Promise.allSettled(Array.from({ length: 5 }, () => auth.login({ username: 'concurrent', password: 'wrong' }, 'parallel')));
    await expect(auth.login({ username: 'concurrent', password: 'wrong' }, 'parallel')).rejects.toMatchObject({ code: 'LOGIN_LIMITED' });
    expect((await auth.login({ username: 'Alice', password: 'changed' }, 'case')).user.username).toBe('Alice');
  });
  it('migrates root once, recalculates ratings and preserves sources, marks and personal aliases', async () => {
    await repository.action('root', { type: 'clear' });
    const legacy = { ...structuredClone(EMPTY_STATE), scores: { [key]: record(1_006_000, 'munet') }, nicknameOverrides: { [first.id]: ['旧别名'] } };
    const migrated = await repository.migrate('root', { state: legacy });
    expect(migrated.state.scores[key]).toMatchObject({ score: 1_006_000, source: 'munet', combo: 'aj', fullChain: 'platinum', rating: calculateRating(1_006_000, first.constant) });
    expect(migrated.state.nicknameOverrides[first.id]).toEqual(['旧别名']);
    await repository.action('root', { type: 'manual', key, score: '1001000' });
    const repeated = await repository.migrate('root', { state: legacy });
    expect(repeated.state.scores[key].score).toBe(1_001_000);
    expect(repeated.revision).toBe(migrated.revision + 1);
    await expect(repository.migrate('alice', { state: legacy })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await repository.get('alice')).state).toEqual(EMPTY_STATE);
  });
  it('keeps failed imports unchanged and transactionally rolls back a database write failure', async () => {
    const before = await repository.get('root');
    await expect(repository.action('root', { type: 'backup', raw: 'invalid', mode: 'replace' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const tooLong = { schemaVersion: 2, scores: [{ ...record(1_007_000), updatedAt: 'x'.repeat(65) }], nicknameOverrides: {} };
    await expect(repository.action('root', { type: 'backup', raw: JSON.stringify(tooLong), mode: 'replace' })).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
    expect(await repository.get('root')).toEqual(before);
  });
  it('merges synchronization with the latest manual score and does not lose concurrent distinct writes', async () => {
    await repository.mergeSync('root', sync(1_008_000), {});
    await repository.action('root', { type: 'manual', key, score: '1000000' });
    const merged = await repository.mergeSync('root', sync(1_005_000), {});
    expect(merged.report).toMatchObject({ importedScores: 0, updatedScores: 1 });
    const current = await repository.get('root');
    expect(current.state.scores[key]).toMatchObject({ score: 1_005_000, source: 'rin', combo: 'aj' });
    await repository.action('root', { type: 'manual', key, score: '1008000' });
    const skipped = await repository.mergeSync('root', sync(1_005_000), {});
    expect(skipped.report).toMatchObject({ importedScores: 0, updatedScores: 0, skippedScores: 1 });
    expect((await repository.get('root')).state.scores[key]).toMatchObject({ score: 1_008_000, source: 'manual' });
    await Promise.all(catalog.slice(1, 8).map((chart, index) => repository.action('root', { type: 'manual', key: `${chart.id}:${chart.difficulty}`, score: String(1_000_000 + index) })));
    expect(Object.keys((await repository.get('root')).state.scores)).toHaveLength(8);
  });
  it('preserves national overwrite rules, equal/lower scores and FC/AJ export data', async () => {
    await repository.mergeSync('root', sync(1_009_000, 'munet'), {});
    await repository.mergeSync('root', sync(1_003_000, 'lxns'), { overwriteMunet: true });
    await repository.mergeSync('root', sync(1_003_000, 'munet'), {});
    expect((await repository.get('root')).state.scores[key].source).toBe('lxns');
    await repository.mergeSync('root', sync(1_002_000, 'munet'), {});
    expect((await repository.get('root')).state.scores[key].score).toBe(1_003_000);
    await repository.mergeSync('root', sync(1_004_000, 'munet'), {});
    const snapshot = await repository.get('root');
    expect(snapshot.state.scores[key].source).toBe('munet');
    const backup = createFullBackup(snapshot.state, 'test');
    expect(backup.scores.find(row => row.id === first.id && row.difficulty === first.difficulty)).toMatchObject({ combo: 'aj', fullChain: 'platinum' });
    const image = createB30Export(Object.values(snapshot.state.scores), catalogByKey, 'test');
    expect(image).toBeDefined();
  });
  it('isolates scores and personal aliases and clears only the active workspace, including obsolete rows', async () => {
    await repository.action('alice', { type: 'manual', key, score: '999000' });
    await repository.action('alice', { type: 'aliases', id: first.id, aliases: [' Only Alice ', 'only alice'] });
    const alice = await repository.get('alice');
    expect(alice.state.nicknameOverrides[first.id]).toEqual(['Only Alice']);
    expect((await repository.get('root')).state.scores[key].score).not.toBe(999000);
    expect((await repository.get('root')).state.nicknameOverrides[first.id]).toEqual(['旧别名']);
    await fixture.db.insert(scores).values({ username: 'alice', songId: 'obsolete', difficulty: 'MAS', score: 1, source: 'manual', updatedAt: 'old' });
    await repository.action('alice', { type: 'clear' });
    expect(await fixture.db.select().from(scores).where(eq(scores.username, 'alice'))).toEqual([]);
    expect(Object.keys((await repository.get('root')).state.scores)).toHaveLength(8);
  });
  it('stores bindings, tokens, browser directories and Otogame checkpoints by username', async () => {
    const a = new MysqlSourceStore(fixture.db, 'root', directory); const b = new MysqlSourceStore(fixture.db, 'alice', directory);
    await a.initialize(); await b.initialize();
    const profile = await a.newProfile('otogame');
    const identity = { id: 'root-game', label: 'root card', cardId: 'card' };
    await a.save('otogame', { binding: { identity, profile }, lastAttemptAt: null, lastSuccessAt: null,
      otogameCache: { identity, records: [record(1_008_000, 'otogame')], checkpoint: { timestamp: 1, boundaryKeys: ['a'.repeat(64)] }, strategy: 'playlog', catalogVersion: 'test' } });
    await a.save('lxns', { binding: { identity: { id: 'root-lxns', label: 'root' }, token: 'fixture-root-private' }, lastAttemptAt: null, lastSuccessAt: null });
    await b.save('lxns', { binding: { identity: { id: 'alice-lxns', label: 'alice' }, token: 'fixture-alice-private' }, lastAttemptAt: null, lastSuccessAt: null });
    expect((await a.load('lxns')).binding?.token).toBe('fixture-root-private');
    expect((await b.load('lxns')).binding?.token).toBe('fixture-alice-private');
    expect((await b.load('otogame')).binding).toBeNull();
    expect(a.profilePath(profile)).not.toBe(b.profilePath(profile));
    const provider = {} as BrowserProvider;
    const manager = new SourceManager({ store: a, providers: { rin: provider, munet: provider, otogame: provider } });
    await manager.initialize();
    expect(JSON.stringify(manager.connections())).not.toContain('fixture-root-private');
    await manager.unbind('otogame');
    expect((await a.load('otogame')).otogameCache).toBeUndefined();
    expect((await b.load('lxns')).binding?.token).toBe('fixture-alice-private');
    await manager.close();
  });
  it('copies old root binding/profile/cache atomically and keeps originals after migration', async () => {
    const base = join(directory, 'legacy'); const old = new SourceStore(base);
    await old.initialize();
    const profile = await old.newProfile('rin');
    await writeFile(join(old.profilePath(profile), 'auth.txt'), 'fixture-cookie');
    await old.save('rin', { binding: { identity: { id: 'legacy', label: 'legacy card' }, profile }, lastAttemptAt: null, lastSuccessAt: null });
    await old.save('lxns', { binding: { identity: { id: 'legacy-lxns', label: 'legacy' }, token: 'legacy-secret' }, lastAttemptAt: null, lastSuccessAt: null });
    await fixture.db.delete(sourceStates).where(eq(sourceStates.username, 'root'));
    await fixture.db.update(workspaces).set({ sourcesMigrated: false }).where(eq(workspaces.username, 'root'));
    const service = new AccountService(fixture.db, base, base);
    try {
      const manager = await service.manager('root');
      expect(manager.connections().find(row => row.source === 'rin')?.bound).toBe(true);
      const owned = new MysqlSourceStore(fixture.db, 'root', base);
      expect(await readFile(join(owned.profilePath(profile), 'auth.txt'), 'utf8')).toBe('fixture-cookie');
      expect(await readFile(join(old.profilePath(profile), 'auth.txt'), 'utf8')).toBe('fixture-cookie');
      expect((await old.load('lxns')).binding?.token).toBe('legacy-secret');
      await manager.unbind('rin');
      expect((await old.load('rin')).binding?.profile).toBe(profile);
      expect((await stat(old.profilePath(profile))).isDirectory()).toBe(true);
    } finally { await service.close(); }
    const restart = new AccountService(fixture.db, base, base);
    try { expect((await restart.manager('root')).connections().find(row => row.source === 'rin')?.bound).toBe(false); }
    finally { await restart.close(); }
  });
  it('does not mark source migration successful when a profile cannot be copied', async () => {
    const base = join(directory, 'failed-legacy'); const old = new SourceStore(base);
    await old.initialize();
    const profile = `rin-${randomUUID()}`;
    await old.save('rin', { binding: { identity: { id: 'failed', label: 'failed' }, profile }, lastAttemptAt: null, lastSuccessAt: null });
    await fixture.db.delete(sourceStates).where(eq(sourceStates.username, 'root'));
    await fixture.db.update(workspaces).set({ sourcesMigrated: false }).where(eq(workspaces.username, 'root'));
    const service = new AccountService(fixture.db, base, base);
    try {
      await expect(service.manager('root')).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await fixture.db.select().from(workspaces).where(eq(workspaces.username, 'root')))[0].sourcesMigrated).toBe(false);
      const owned = new MysqlSourceStore(fixture.db, 'root', base);
      await expect(stat(owned.profilePath(profile))).rejects.toMatchObject({ code: 'ENOENT' });
      await mkdir(old.profilePath(profile)); await writeFile(join(old.profilePath(profile), 'file'), 'ok');
      expect((await service.manager('root')).connections().find(row => row.source === 'rin')?.bound).toBe(true);
    } finally { await service.close(); }
  });
  it('HTTP authenticates every data route, ignores supplied usernames and never exports secrets', async () => {
    await fixture.db.update(workspaces).set({ sourcesMigrated: true }).where(eq(workspaces.username, 'root'));
    const service = new AccountService(fixture.db, join(directory, 'http'), directory);
    const server = createAppServer({ accounts: service });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port');
    const url = `http://127.0.0.1:${address.port}`;
    const write = { 'Content-Type': 'application/json', 'X-Machun-Request': '1' };
    try {
      for (const path of ['/api/catalog', '/api/workspace', '/api/sources']) expect((await fetch(url + path)).status).toBe(401);
      const login = await fetch(url + '/api/auth/login', { method: 'POST', headers: write, body: JSON.stringify({ username: 'alice', password: 'alice-pwd' }) });
      expect(await login.json()).toEqual({ user: { username: 'alice' } });
      const cookie = login.headers.get('set-cookie')!;
      expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Lax');
      const options = { method: 'POST', headers: { ...write, Cookie: cookie.split(';')[0] }, body: JSON.stringify({ type: 'manual', username: 'root', key, score: '980000' }) };
      const result = await fetch(url + '/api/workspace/actions', options);
      expect(result.status).toBe(200);
      expect((await repository.get('alice')).state.scores[key].score).toBe(980000);
      expect((await repository.get('root')).state.scores[key].score).not.toBe(980000);
      const sources = await fetch(url + '/api/sources', { headers: { Cookie: cookie.split(';')[0] } });
      expect(await sources.text()).not.toContain('fixture-alice-private');
      expect((await fetch(url + '/api/auth/register', { method: 'POST', headers: write, body: '{}' })).status).toBe(404);
      await fetch(url + '/api/auth/logout', { method: 'POST', headers: { ...write, Cookie: cookie.split(';')[0] }, body: '{}' });
      expect((await fetch(url + '/api/workspace', { headers: { Cookie: cookie.split(';')[0] } })).status).toBe(401);
    } finally { await service.close(); await new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections(); }
  });

  it('all Docker branch users use a manual launcher without reading portal credentials', async () => {
    const readers: unknown[][] = [];
    const launcher = vi.spyOn(browserModule, 'createBrowserLauncher').mockImplementation((...args) => {
      readers.push(args);
      return { async open() { throw new Error('No browser should open during initialization'); } };
    });
    const service = new AccountService(fixture.db, directory, directory);
    try { await service.manager('root'); await service.manager('alice'); expect(readers).toEqual([[], []]); }
    finally { await service.close(); launcher.mockRestore(); }
  });

  const portable = { version: 1 as const, source: 'rin' as const, localStorage: { currentAccount: '{"accessToken":"fixture-access","tokenType":"Bearer","refreshToken":"fixture-renew"}' } };
  const boundIdentity = { id: 'companion-account', label: '测试玩家', cardId: 'test-card' };
  async function tasks(now: () => number = Date.now) {
    const login = await auth.login({ username: 'root', password: 'pwd' }, 'task-fixture');
    let release: (() => void) | undefined;
    let hold: Promise<void> | undefined;
    let failure = false;
    const binder = vi.fn(async (_source: string, _session: unknown, _identity: unknown, persist: (state: SavedSource) => Promise<void>) => {
      if (hold) await hold;
      if (failure) throw new SyncError('IDENTITY_CHANGED', '账号或卡片不匹配', 409);
      await persist({ binding: { identity: boundIdentity, session: portable }, lastAttemptAt: null, lastSuccessAt: null });
      return sync(1).connection;
    });
    const manager = { connections: () => [sync(1).connection], bindPortable: binder } as unknown as SourceManager;
    const service = new BindingTaskService(fixture.db, async () => manager, now);
    return { login, service, binder, manager, wait() { hold = new Promise<void>(resolve => { release = resolve; }); }, resume() { release?.(); }, fail() { failure = true; } };
  }
  it('binding codes are hashed, task access is isolated, and a submission is accepted only once', async () => {
    const t = await tasks();
    try {
      const created = await t.service.create('root', 'rin', t.login.token);
      const [stored] = await fixture.db.select().from(bindingTasks).where(eq(bindingTasks.id, created.id));
      expect(stored.codeHash).toBe(hashToken(created.code)); expect(JSON.stringify(stored)).not.toContain(created.code);
      expect((await t.service.companion(created.id, created.code)).loginUrl).toBe('https://portal.naominet.live/');
      await expect(t.service.companion(created.id, 'wrong')).rejects.toMatchObject({ code: 'INVALID_BINDING_CODE' });
      await expect(t.service.get('alice', created.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(t.service.cancel('alice', created.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      t.wait();
      await t.service.submit(created.id, created.code, { session: portable, identity: boundIdentity, username: 'alice' });
      await expect(t.service.submit(created.id, created.code, { session: portable, identity: boundIdentity })).rejects.toMatchObject({ code: 'TASK_USED' });
      t.resume(); await vi.waitFor(async () => expect((await t.service.get('root', created.id)).status).toBe('complete'));
      const state = (await fixture.db.select().from(sourceStates).where(eq(sourceStates.username, 'root'))).find(row => row.source === 'rin')?.state;
      expect(state?.binding?.session).toEqual(portable); expect(t.binder).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(await t.service.companion(created.id, created.code))).not.toMatch(/fixture-access|fixture-renew|codeHash|sessionHash/);
    } finally { t.resume(); await t.service.close(); }
  });
  it('regeneration, expiration, logout and service restart invalidate outstanding codes', async () => {
    let clock = Date.now(); const t = await tasks(() => clock);
    try {
      const first = await t.service.create('root', 'rin', t.login.token);
      const second = await t.service.create('root', 'rin', t.login.token);
      expect((await t.service.get('root', first.id)).status).toBe('cancelled');
      clock += 10 * 60_000 + 1;
      expect((await t.service.companion(second.id, second.code)).status).toBe('expired');
      await expect(t.service.submit(second.id, second.code, { session: portable, identity: boundIdentity })).rejects.toMatchObject({ code: 'TASK_USED' });
      clock = Date.now();
      const third = await t.service.create('root', 'rin', t.login.token);
      await auth.logout(t.login.token);
      expect((await t.service.get('root', third.id)).status).toBe('expired');
      const login = await auth.login({ username: 'root', password: 'pwd' }, 'restart-task');
      const fourth = await t.service.create('root', 'rin', login.token);
      const restart = new BindingTaskService(fixture.db, async () => t.manager);
      try { expect((await restart.get('root', fourth.id)).status).toBe('expired'); }
      finally { await restart.close(); }
      expect(t.binder).not.toHaveBeenCalled();
    } finally { await t.service.close(); }
  });
  it('cancellation or identity failure never overwrites the previous binding or scores', async () => {
    const t = await tasks(); const before = await repository.get('root');
    const store = new MysqlSourceStore(fixture.db, 'root', directory);
    const old = await store.load('rin');
    try {
      t.wait(); const created = await t.service.create('root', 'rin', t.login.token);
      await t.service.submit(created.id, created.code, { session: portable, identity: boundIdentity });
      await vi.waitFor(() => expect(t.binder).toHaveBeenCalled());
      await t.service.cancel('root', created.id); t.resume(); await t.service.close();
      expect((await t.service.get('root', created.id)).status).toBe('cancelled');
      expect(await store.load('rin')).toEqual(old); expect(await repository.get('root')).toEqual(before);
      t.fail(); const next = await t.service.create('root', 'rin', t.login.token);
      await t.service.submit(next.id, next.code, { session: portable, identity: boundIdentity });
      await vi.waitFor(async () => expect((await t.service.get('root', next.id)).status).toBe('failed'));
      expect(await store.load('rin')).toEqual(old);
    } finally { t.resume(); await t.service.close(); }
  });
  it('expiry during browser validation cannot replace the previous database binding', async () => {
    let clock = Date.now(); const t = await tasks(() => clock);
    const store = new MysqlSourceStore(fixture.db, 'root', directory); const before = await store.load('rin');
    try {
      t.wait(); const created = await t.service.create('root', 'rin', t.login.token);
      await t.service.submit(created.id, created.code, { session: portable, identity: boundIdentity });
      await vi.waitFor(() => expect(t.binder).toHaveBeenCalled());
      clock += 10 * 60_000 + 1;
      expect((await t.service.get('root', created.id)).status).toBe('expired');
      t.resume(); await t.service.close();
      expect(await store.load('rin')).toEqual(before);
    } finally { t.resume(); await t.service.close(); }
  });
  it('HTTP task routes require the owning login or the binding code and logout revokes pending work', async () => {
    await fixture.db.update(workspaces).set({ sourcesMigrated: true }).where(eq(workspaces.username, 'root'));
    const service = new AccountService(fixture.db, join(directory, 'tasks-http'), directory, { companionLogin: true });
    const server = createAppServer({ accounts: service });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('port');
    const origin = `http://127.0.0.1:${address.port}`;
    const headers = { 'Content-Type': 'application/json', 'X-Machun-Request': '1' };
    try {
      const path = '/api/sources/rin/binding-tasks';
      expect((await fetch(origin + path, { method: 'POST', headers, body: '{}' })).status).toBe(401);
      const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers, body: '{"username":"root","password":"pwd"}' });
      const own = { ...headers, Cookie: login.headers.get('set-cookie')!.split(';')[0] };
      const response = await fetch(origin + path, { method: 'POST', headers: own, body: '{}' }); expect(response.status).toBe(201);
      const task = await response.json();
      expect((await fetch(origin + `/api/companion/binding-tasks/${task.id}`)).status).toBe(401);
      const companion = await fetch(origin + `/api/companion/binding-tasks/${task.id}`, { headers: { Authorization: `Bearer ${task.code}` } });
      expect(companion.status).toBe(200); expect(await companion.text()).not.toContain(task.code);
      expect((await fetch(origin + '/api/sources/rin/bind', { method: 'POST', headers: own, body: '{}' })).status).toBe(409);
      await fetch(origin + '/api/auth/logout', { method: 'POST', headers: own, body: '{}' });
      expect((await service.bindingTasks.companion(task.id, task.code)).status).toBe('cancelled');
    } finally { await service.close(); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
  });
});
