import { setTimeout as delay } from "node:timers/promises";
import { stat } from "node:fs/promises";
import type { ExternalScoreSource } from "../src/core/sources";
import { importSourcePayload } from "../src/core/sources";
import { CATALOG_VERSION, catalogByKey } from "../src/core/catalog";
import { EMPTY_STATE } from "../src/core/storage";
import { SYNC_SOURCES, type BrowserSource, type SourceConnection, type SourceIdentity, type SyncOptions, type SyncProgress, type SyncResult } from "../src/syncTypes";
import { requireIdentity, SyncError, type BrowserProvider, type BrowserSession, type OtogameCheckpoint } from "./provider";
import type { PortableSession } from "../src/sourceBindingTypes";
import { capturePortableSession, validatePortableSession } from "./portableSession";
import { SourceStore, type SavedBinding, type SavedSource } from "./store";
import { browserLauncher, type BrowserLauncher } from "./browser";
import { LxnsProvider } from "./providers/lxns";

interface Slot {
  saved: SavedSource;
  connection: SourceConnection;
  operation?: "bind" | "sync" | "unbind";
  task?: Promise<unknown>;
  abort?: AbortController;
  session?: BrowserSession;
}

export interface ManagerOptions {
  store: SourceStore;
  providers: Record<BrowserSource, BrowserProvider>;
  launcher?: BrowserLauncher;
  lxns?: LxnsProvider;
  bindTimeoutMs?: number;
  bindPollMs?: number;
  companionLogin?: boolean;
}

export function safeError(error: unknown): SyncError {
  if (error instanceof SyncError) return error;
  return new SyncError("SERVICE_ERROR", "本地服务无法完成操作，请检查网络和本地目录权限后重试。", 500);
}

export class SourceManager {
  private readonly slots = new Map<ExternalScoreSource, Slot>();
  private readonly launcher: BrowserLauncher;
  private readonly lxns: LxnsProvider;
  private closing = false;

  constructor(private readonly options: ManagerOptions) {
    this.launcher = options.launcher ?? browserLauncher;
    this.lxns = options.lxns ?? new LxnsProvider();
  }

  async initialize(): Promise<void> {
    await this.options.store.initialize();
    for (const source of SYNC_SOURCES) {
      const saved = await this.options.store.load(source);
      this.slots.set(source, {
        saved,
        connection: {
          source, status: saved.binding ? "ready" : "unbound", bound: Boolean(saved.binding),
          identity: saved.binding?.identity ?? null, lastAttemptAt: saved.lastAttemptAt,
          lastSuccessAt: saved.lastSuccessAt, error: null,
          bindingMode: this.options.companionLogin && source !== 'lxns' ? 'companion' : 'window',
        },
      });
      if (source !== 'lxns' && saved.binding?.profile && !saved.binding.session) {
        try { await stat(this.options.store.profilePath(saved.binding.profile)); }
        catch { Object.assign(this.slot(source).connection, { status: 'auth_required', error: '旧浏览器目录不在当前服务器，请用登录助手重新绑定；已有成绩保留。' }); }
      }
    }
  }

  private slot(source: ExternalScoreSource): Slot {
    const slot = this.slots.get(source);
    if (!slot) throw new SyncError("INVALID_SOURCE", "不支持该成绩来源。", 404);
    return slot;
  }

  connections(): SourceConnection[] {
    return SYNC_SOURCES.map((source) => structuredClone(this.slot(source).connection));
  }

  private available(slot: Slot): void {
    if (this.closing) throw new SyncError("SHUTTING_DOWN", "服务正在关闭。", 503);
    if (slot.operation) {
      throw new SyncError("BUSY", "该来源正在处理，请等待完成。", 409);
    }
  }

  private operate<T>(slot: Slot, operation: "bind" | "sync" | "unbind", work: () => Promise<T>): Promise<T> {
    slot.operation = operation;
    const task = Promise.resolve().then(work).finally(() => {
      // Cancelling a login replaces its task with the unbind task. Its late cleanup
      // must not unlock or detach the newer operation.
      if (slot.task === task) {
        slot.task = undefined;
        slot.operation = undefined;
      }
    });
    slot.task = task;
    return task;
  }

  private fail(slot: Slot, error: unknown): SyncError {
    const safe = safeError(error);
    slot.connection.status = safe.code === "AUTH_REQUIRED" || safe.code === "IDENTITY_CHANGED" ? "auth_required" : "error";
    slot.connection.error = safe.message;
    return safe;
  }

  private async commitBinding(slot: Slot, binding: SavedBinding, persist?: (saved: SavedSource) => Promise<void>): Promise<void> {
    const previous = slot.saved.binding;
    const cache = slot.saved.otogameCache;
    const saved: SavedSource = {
      binding, lastAttemptAt: null, lastSuccessAt: null,
      ...(cache && cache.identity.id === binding.identity.id && cache.identity.cardId === binding.identity.cardId
        ? { otogameCache: cache } : {}),
    };
    if (persist) await persist(saved); else await this.options.store.save(slot.connection.source, saved);
    slot.saved = saved;
    if (previous?.profile && previous.profile !== binding.profile) {
      await this.options.store.removeProfile(previous.profile).catch(() => undefined);
    }
    Object.assign(slot.connection, {
      bound: true, identity: binding.identity, status: "ready", error: null,
      lastAttemptAt: null, lastSuccessAt: null,
    });
  }

  async bindPortable(source: BrowserSource, input: PortableSession, expected: SourceIdentity,
    persist?: (saved: SavedSource) => Promise<void>, signal?: AbortSignal): Promise<SourceConnection> {
    const slot = this.slot(source);
    this.available(slot);
    const state = validatePortableSession(source, input);
    if (!this.launcher.openPortable) throw new SyncError('BROWSER_UNAVAILABLE', '浏览器不支持可移植会话。', 503);
    return this.operate(slot, 'bind', async () => {
      slot.connection.status = 'binding'; slot.connection.error = null;
      const cancelled = () => { if (signal?.aborted) throw new SyncError('TASK_CANCELLED', '绑定任务已取消或失效。', 409); };
      const onAbort = () => { void slot.session?.context.close().catch(() => undefined); };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        cancelled();
        const provider = this.options.providers[source];
        slot.session = await this.launcher.openPortable!(state, provider.loginUrl);
        cancelled();
        const identity = await provider.identify(slot.session);
        requireIdentity(identity, expected);
        const session = await capturePortableSession(slot.session.context, source);
        await slot.session.context.close(); slot.session = undefined;
        cancelled();
        await this.commitBinding(slot, { identity, session }, persist);
        return structuredClone(slot.connection);
      } catch (error) { throw this.fail(slot, error); }
      finally {
        signal?.removeEventListener('abort', onAbort);
        await slot.session?.context.close().catch(() => undefined); slot.session = undefined;
      }
    });
  }

  async bind(source: ExternalScoreSource, token?: string): Promise<SourceConnection> {
    const slot = this.slot(source);
    this.available(slot);
    if (source !== 'lxns' && this.options.companionLogin) throw new SyncError('COMPANION_REQUIRED', '请创建绑定任务并在电脑运行登录助手。', 409);
    if (source === "lxns") {
      const normalized = token?.trim();
      if (!normalized || normalized.length > 4096 || /[\r\n\x00-\x1f]/.test(normalized)) {
        throw new SyncError("INVALID_TOKEN", "请输入有效的落雪个人 API Token。", 400);
      }
      slot.connection.status = "binding";
      slot.connection.error = null;
      // Keep the operation attached to the slot so cancellation cannot race a late save.
      await this.operate(slot, "bind", async () => {
        try {
          const identity = await this.lxns.identify(normalized);
          await this.commitBinding(slot, { identity, token: normalized });
        } catch (error) { throw this.fail(slot, error); }
      });
    } else {
      slot.connection.status = "binding";
      slot.connection.error = null;
      slot.abort = new AbortController();
      const signal = slot.abort.signal;
      const task = this.operate(slot, "bind", () => this.bindBrowser(source, slot, signal));
      // Binding runs while the user completes the portal's own login window.
      void task.catch(() => undefined);
    }
    return structuredClone(slot.connection);
  }

  private async bindBrowser(source: BrowserSource, slot: Slot, signal: AbortSignal): Promise<void> {
    let profile: string | undefined;
    let committed = false;
    try {
      profile = await this.options.store.newProfile(source);
      const provider = this.options.providers[source];
      if (signal.aborted) return;
      const session = await this.launcher.open(this.options.store.profilePath(profile), provider.loginUrl, true);
      slot.session = session;
      const portalOrigin = new URL(provider.loginUrl).origin;
      const deadline = Date.now() + (this.options.bindTimeoutMs ?? 5 * 60_000);
      let transientFailures = 0;
      while (!signal.aborted && Date.now() < deadline) {
        const pages = session.context.pages().filter((page) => !page.isClosed());
        if (pages.length === 0) break;
        // OAuth can return into a new tab after its original page has closed.
        // Never inspect credentials on the external login/consent page itself.
        const portalPage = pages.findLast((page) => {
          try { return new URL(page.url()).origin === portalOrigin; }
          catch { return false; }
        });
        if (!portalPage) {
          await delay(this.options.bindPollMs ?? 1500, undefined, { signal });
          continue;
        }
        session.page = portalPage;
        let identity: SourceIdentity | undefined;
        try {
          identity = await provider.identify(session);
          transientFailures = 0;
        } catch (error) {
          if (signal.aborted) return;
          if (error instanceof SyncError && error.code === "AUTH_REQUIRED") {
            transientFailures = 0;
          } else {
            if (error instanceof SyncError && error.code !== "NETWORK_ERROR" && error.code !== "UPSTREAM_UNAVAILABLE") throw error;
            // Navigation can destroy the JS context or interrupt a portal request.
            // Stop after three retries, including unwrapped browser exceptions.
            if (++transientFailures > 3) throw error;
          }
        }
        if (identity) {
          if (signal.aborted) return;
          const portable = await capturePortableSession(session.context, source).catch(() => undefined);
          // Close first to flush the legacy profile, while keeping a portable snapshot when available.
          await session.context.close();
          slot.session = undefined;
          if (signal.aborted) return;
          await this.commitBinding(slot, { identity, profile, ...(portable ? { session: portable } : {}) });
          committed = true;
          return;
        }
        await delay(this.options.bindPollMs ?? 1500, undefined, { signal });
      }
      if (!signal.aborted) throw new SyncError("LOGIN_CANCELLED", "登录窗口已关闭或等待超时，请重新登录。", 408);
    } catch (error) {
      if (!signal.aborted) this.fail(slot, error);
    } finally {
      await slot.session?.context.close().catch(() => undefined);
      slot.session = undefined;
      if (profile && !committed) await this.options.store.removeProfile(profile).catch(() => undefined);
      slot.abort = undefined;
    }
  }

  async unbind(source: ExternalScoreSource): Promise<SourceConnection> {
    const slot = this.slot(source);
    if (slot.operation === "sync" || slot.operation === "unbind" || (source === "lxns" && slot.operation)) {
      throw new SyncError("BUSY", "该来源正在处理，请等待完成后解绑。", 409);
    }
    if (this.closing) throw new SyncError("SHUTTING_DOWN", "服务正在关闭。", 503);
    const preceding = slot.task;
    slot.abort?.abort();
    return this.operate(slot, "unbind", async () => {
      await slot.session?.context.close().catch(() => undefined);
      await preceding?.catch(() => undefined);
      const previous = slot.saved.binding;
      const saved = { binding: null, lastAttemptAt: null, lastSuccessAt: null };
      await this.options.store.save(source, saved);
      slot.saved = saved;
      if (previous?.profile) await this.options.store.removeProfile(previous.profile);
      Object.assign(slot.connection, { status: "unbound", bound: false, identity: null, error: null, lastAttemptAt: null, lastSuccessAt: null });
      return structuredClone(slot.connection);
    });
  }

  async sync(source: ExternalScoreSource, options: SyncOptions = {}): Promise<SyncResult> {
    if (options.full && source !== "otogame") throw new SyncError("INVALID_REQUEST", "只有大饼支持全量校准。", 400);
    const slot = this.slot(source);
    this.available(slot);
    const binding = slot.saved.binding;
    if (!binding) throw new SyncError("NOT_BOUND", "请先绑定该来源。", 409);
    slot.connection.status = "syncing";
    slot.connection.error = null;
    delete slot.connection.progress;
    slot.saved.lastAttemptAt = new Date().toISOString();
    slot.connection.lastAttemptAt = slot.saved.lastAttemptAt;
    return this.operate(slot, "sync", () => this.performSync(source, slot, binding, options));
  }

  private async performSync(source: ExternalScoreSource, slot: Slot, binding: SavedBinding, options: SyncOptions): Promise<SyncResult> {
    const task = slot.task;
    const onProgress = (progress: SyncProgress) => {
      if (slot.task !== task || slot.operation !== "sync" || slot.connection.status !== "syncing") return;
      slot.connection.progress = { completedPages: progress.completedPages, retryAt: progress.retryAt };
    };
    try {
      await this.options.store.save(source, slot.saved);
      let payload: unknown;
      let checkpoint: OtogameCheckpoint | undefined;
      let previousCache: SavedSource["otogameCache"];
      if (source === "lxns") {
        payload = await this.lxns.fetchScores(binding.token!, binding.identity);
      } else {
        const provider = this.options.providers[source];
        if (binding.session) {
          if (!this.launcher.openPortable) throw new SyncError('BROWSER_UNAVAILABLE', '浏览器不支持可移植会话。', 503);
          slot.session = await this.launcher.openPortable(binding.session, provider.loginUrl);
        } else {
          if (!binding.profile) throw new SyncError('AUTH_REQUIRED', '请重新绑定该来源。', 401);
          try { await stat(this.options.store.profilePath(binding.profile)); }
          catch { throw new SyncError('AUTH_REQUIRED', '旧浏览器目录缺失，请用登录助手重新绑定。', 401); }
          slot.session = await this.launcher.open(this.options.store.profilePath(binding.profile), provider.loginUrl, false);
        }
        if (this.closing) throw new SyncError("SHUTTING_DOWN", "服务正在关闭。", 503);
        if (source === "otogame" && provider.fetchScoreChanges) {
          previousCache = slot.saved.otogameCache;
          // An older catalog may have skipped charts that are eligible now. Replay
          // available history once before trusting its checkpoint for this coverage.
          const resumeCheckpoint = !options.full && previousCache
            && previousCache.catalogVersion === CATALOG_VERSION && previousCache.strategy === "playlog"
            ? previousCache.checkpoint : undefined;
          const batch = await provider.fetchScoreChanges(slot.session, binding.identity,
            resumeCheckpoint, onProgress);
          payload = batch.payload;
          checkpoint = batch.checkpoint;
        } else {
          payload = await provider.fetchScores(slot.session, binding.identity, onProgress);
        }
        const session = await capturePortableSession(slot.session.context, source).catch(error => {
          if (binding.session) throw error; return undefined;
        });
        if (session) {
          const renewed = { ...slot.saved, binding: { ...binding, session } };
          await this.options.store.save(source, renewed); slot.saved = renewed;
        }
        await slot.session.context.close();
        slot.session = undefined;
      }
      // Re-normalize the cache through today's catalog before merging newer playlog scores.
      const previousState = previousCache
        ? importSourcePayload(previousCache.records, source, EMPTY_STATE, catalogByKey).state : EMPTY_STATE;
      const { state, report } = importSourcePayload(payload, source, previousState, catalogByKey);
      if ((checkpoint && report.invalidEntries > 0) || (report.parsedScores > 0 && report.invalidEntries === report.parsedScores)) {
        throw new SyncError("INVALID_RESPONSE", "来源返回的成绩字段无法识别，本次未更新成绩。");
      }
      const completedAt = new Date().toISOString();
      const records = Object.values(state.scores);
      const saved: SavedSource = {
        ...slot.saved, lastSuccessAt: completedAt,
        ...(checkpoint ? { otogameCache: {
          identity: structuredClone(binding.identity), records: structuredClone(records), checkpoint: structuredClone(checkpoint),
          catalogVersion: CATALOG_VERSION, strategy: "playlog",
        } } : {}),
      };
      // The checkpoint and normalized scores commit atomically; a lost HTTP response can
      // be recovered by returning this entire cache on the next incremental request.
      await this.options.store.save(source, saved);
      slot.saved = saved;
      slot.connection.lastSuccessAt = completedAt;
      slot.connection.status = "ready";
      delete slot.connection.progress;
      return { source, records, report, connection: structuredClone(slot.connection) };
    } catch (error) {
      delete slot.connection.progress;
      throw this.fail(slot, error);
    } finally {
      await slot.session?.context.close().catch(() => undefined);
      slot.session = undefined;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const slot of this.slots.values()) slot.abort?.abort();
    await Promise.all([...this.slots.values()].map(async (slot) => {
      await slot.session?.context.close().catch(() => undefined);
      await slot.task?.catch(() => undefined);
    }));
  }
}
