import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { Database } from './db/connection';
import { withDatabase } from './db/connection';
import { sourceStates, workspaces } from './db/schema';
import { loadCatalog } from './db/catalog';
import { SourceStore, validateSavedSource, type SavedSource } from './store';
import { SourceManager } from './manager';
import { createBrowserLauncher } from './browser';
import { createCredentialReader } from './credentials';
import { rinProvider } from './providers/rin';
import { munetProvider } from './providers/munet';
import { otogameProvider } from './providers/otogame';
import { AccountAuth } from './auth';
import { WorkspaceRepository } from './workspace';
import { SYNC_SOURCES } from '../src/syncTypes';
import { installCatalogSnapshot } from '../src/core/catalog';
import { installSongChartDetails } from '../src/core/songDetails';
import type { CatalogSnapshot } from '../src/accountTypes';
import type { ExternalScoreSource } from '../src/core/sources';
import type { HttpManager } from './http';
import { SyncError } from './provider';

export class MysqlSourceStore extends SourceStore {
  constructor(private readonly db: Database, readonly username: string, base: string) {
    super(join(base, 'users', createHash('sha256').update(username).digest('hex')));
  }
  override async load(source: ExternalScoreSource): Promise<SavedSource> {
    return withDatabase(async () => {
      const [row] = await this.db.select().from(sourceStates).where(and(eq(sourceStates.username, this.username), eq(sourceStates.source, source)));
      return row ? validateSavedSource(source, row.state) : { binding: null, lastAttemptAt: null, lastSuccessAt: null };
    });
  }
  override async save(source: ExternalScoreSource, state: SavedSource): Promise<void> {
    validateSavedSource(source, state);
    await withDatabase(async () => {
      const row = { username: this.username, source, state };
      await this.db.insert(sourceStates).values(row).onDuplicateKeyUpdate({ set: { state } });
    });
  }
}
export interface AccountBackend {
  auth: Pick<AccountAuth, 'login' | 'account' | 'logout'>;
  workspace: Pick<WorkspaceRepository, 'get' | 'action' | 'migrate' | 'mergeSync'>;
  catalog(): Promise<CatalogSnapshot>;
  manager(username: string): Promise<HttpManager>;
}
export class AccountService implements AccountBackend {
  readonly auth: AccountAuth;
  readonly workspace: WorkspaceRepository;
  private snapshot?: Promise<CatalogSnapshot>;
  private managers = new Map<string, Promise<SourceManager>>();
  private legacyMigration?: Promise<void>;
  constructor(private readonly db: Database, private readonly dataDirectory: string, private readonly projectRoot: string) {
    this.auth = new AccountAuth(db);
    this.workspace = new WorkspaceRepository(db);
  }
  async catalog(): Promise<CatalogSnapshot> {
    if (!this.snapshot) this.snapshot = loadCatalog(this.db).then(snapshot => {
      installCatalogSnapshot(snapshot);
      installSongChartDetails(snapshot.details);
      return snapshot;
    }).catch(error => { this.snapshot = undefined; throw error; });
    return this.snapshot;
  }
  private async migrateLegacy(): Promise<void> {
    const [workspace] = await withDatabase(() => this.db.select().from(workspaces).where(eq(workspaces.username, 'root')));
    if (workspace?.sourcesMigrated) return;
    const old = new SourceStore(this.dataDirectory);
    const owned = new MysqlSourceStore(this.db, 'root', this.dataDirectory);
    await owned.initialize();
    const saved = await Promise.all(SYNC_SOURCES.map(async source => ({ source, state: await old.load(source) })));
    let copied = 0;
    for (const { state } of saved) {
      if (!state.binding?.profile) continue;
      const from = old.profilePath(state.binding.profile);
      const to = owned.profilePath(state.binding.profile);
      try { await stat(to); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        try {
          await lstat(join(from, 'SingletonLock'));
          throw new SyncError('STORAGE_ERROR', '旧登录窗口尚未关闭，请关闭后重试来源迁移。', 409);
        } catch (lockError) { if ((lockError as NodeJS.ErrnoException).code !== 'ENOENT') throw lockError; }
        const temporary = `${to}.${randomUUID()}.tmp`;
        try {
          await cp(from, temporary, { recursive: true, filter: path => !basename(path).startsWith('Singleton') && basename(path) !== 'DevToolsActivePort' });
          await rename(temporary, to);
          copied++;
        } finally { await rm(temporary, { recursive: true, force: true }).catch(() => undefined); }
      }
    }
    await withDatabase(() => this.db.transaction(async tx => {
      await tx.insert(workspaces).values({ username: 'root' }).onDuplicateKeyUpdate({ set: { username: 'root' } });
      await tx.select().from(workspaces).where(eq(workspaces.username, 'root')).for('update');
      for (const { source, state } of saved) {
        const [existing] = await tx.select().from(sourceStates).where(and(eq(sourceStates.username, 'root'), eq(sourceStates.source, source)));
        if (!existing) await tx.insert(sourceStates).values({ username: 'root', source, state });
      }
      await tx.update(workspaces).set({ sourcesMigrated: true }).where(eq(workspaces.username, 'root'));
    }));
    console.log(JSON.stringify({ legacySourceMigration: { boundSources: saved.filter(row => row.state.binding).length, copiedProfiles: copied, cachedScores: saved.find(row => row.source === 'otogame')?.state.otogameCache?.records.length ?? 0 } }));
  }
  async manager(username: string): Promise<SourceManager> {
    await this.catalog();
    if (username === 'root') {
      if (!this.legacyMigration) this.legacyMigration = this.migrateLegacy().catch(error => { this.legacyMigration = undefined; throw error; });
      await this.legacyMigration;
    }
    let manager = this.managers.get(username);
    if (!manager) {
      const instance = new SourceManager({
        store: new MysqlSourceStore(this.db, username, this.dataDirectory),
        providers: { rin: rinProvider, munet: munetProvider, otogame: otogameProvider },
        launcher: createBrowserLauncher(username === 'root' ? createCredentialReader(join(this.projectRoot, '.env')) : async () => null),
      });
      manager = instance.initialize().then(() => instance).catch(error => { this.managers.delete(username); throw error; });
      this.managers.set(username, manager);
    }
    return manager;
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.managers.values()].map(async manager => (await manager).close()));
    this.managers.clear();
  }
}
