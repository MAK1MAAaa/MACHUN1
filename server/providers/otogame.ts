import { createHash } from "node:crypto";
import type { SourceIdentity, SyncProgress } from "../../src/syncTypes";
import { requireIdentity, SyncError } from "../provider";
import type { BrowserProvider, BrowserSession, OtogameCheckpoint } from "../provider";
import type { ScoreAchievements } from "../../src/types";
import { mergeScoreAchievements, readScoreAchievements } from "../../src/core/scoreAchievements";

const ORIGIN = "https://u.otogame.net";
const STORAGE_KEYS = ["TOKEN", "ID_TOKEN", "REFRESH_TOKEN", "USER_INFO"] as const;
type StorageKey = typeof STORAGE_KEYS[number];
type StoredValue = { value?: unknown; time?: number; expire?: number | null };
type TokenKey = "TOKEN" | "ID_TOKEN";
type JsonObject = Record<string, unknown>;
const DAY = 86_400_000;
const REQUEST_TIMEOUT = 20_000;
const MAX_PAGES = 2_000;
const GAME_REQUEST_INTERVAL = 1_100;
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_WAIT = 15 * 60_000;
const MAX_TOTAL_WAIT = 35 * 60_000;
type ProgressReporter = (progress: SyncProgress) => void;

class GameRateLimit extends Error {
  constructor(readonly retryAfter: string | undefined) { super("Game rate limit"); }
}

function rateLimited(delay?: number): SyncError {
  const retry = delay !== undefined && Number.isFinite(delay)
    ? `请等待至少 ${Math.ceil(delay / 1_000)} 秒后重试。` : "请稍后重试。";
  return new SyncError("RATE_LIMITED", `大饼请求过于频繁，${retry}本次同步未导入。`, 429);
}

function retryDelay(header: string | undefined, retry: number): number {
  const value = header?.trim();
  let delay = 2_000 * 2 ** retry;
  if (value) {
    if (/^\d+(?:\.\d+)?$/.test(value)) delay = Number(value) * 1_000;
    else {
      const deadline = Date.parse(value);
      if (Number.isFinite(deadline)) delay = Math.max(0, deadline - Date.now());
    }
  }
  // Never shorten a server-requested cooldown just to fit the local retry budget.
  if (!Number.isFinite(delay) || delay > MAX_RETRY_WAIT) throw rateLimited(delay);
  return delay;
}

function cancelled(): SyncError {
  return new SyncError("SYNC_CANCELLED", "大饼同步已取消，本次未导入成绩。", 409);
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject : undefined;
}

function invalidResponse(): SyncError {
  return new SyncError("INVALID_RESPONSE", "大饼返回的数据格式异常，本次同步未导入。");
}

function authRequired(): SyncError {
  return new SyncError("AUTH_REQUIRED", "大饼登录已失效，请重新登录后同步。", 401);
}

// The official client camel-cases API responses; persisted browser values already use camelCase.
function camelCase(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelCase);
  const record = object(value);
  return record ? Object.fromEntries(Object.entries(record).map(([key, child]) => [
    key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), camelCase(child),
  ])) : value;
}

function identifier(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return undefined;
}

class OtogameApi {
  private storage: Partial<Record<StorageKey, StoredValue>> = {};
  private lastGameRequestAt: number | undefined;
  private totalWait = 0;
  private completedPages = 0;
  private readonly abort = new AbortController();
  private readonly onClose = () => this.abort.abort();

  constructor(private readonly session: BrowserSession, private readonly reportProgress?: ProgressReporter) {
    session.context.on("close", this.onClose);
  }

  dispose(): void {
    this.session.context.off("close", this.onClose);
    this.abort.abort();
  }

  pageCompleted(): void {
    this.completedPages += 1;
    this.reportProgress?.({ completedPages: this.completedPages, retryAt: null });
  }

  private async wait(milliseconds: number, cooldown = false): Promise<void> {
    const signal = this.abort.signal;
    if (signal.aborted) throw cancelled();
    if (milliseconds + this.totalWait > MAX_TOTAL_WAIT) {
      throw new SyncError("RATE_LIMITED", "大饼本次同步的累计等待将超过 35 分钟，请稍后重试。本次未导入成绩。", 429);
    }
    this.totalWait += milliseconds;
    if (cooldown) this.reportProgress?.({ completedPages: this.completedPages, retryAt: new Date(Date.now() + milliseconds).toISOString() });
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
        };
        const onAbort = () => { cleanup(); reject(cancelled()); };
        const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    } finally {
      if (cooldown) this.reportProgress?.({ completedPages: this.completedPages, retryAt: null });
    }
  }

  async restore(): Promise<void> {
    try {
      const values = await this.session.page.evaluate(({ origin, keys }) => {
        if (location.origin !== origin) return null;
        return Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)]));
      }, { origin: ORIGIN, keys: [...STORAGE_KEYS] });
      if (!values) throw authRequired();
      for (const key of STORAGE_KEYS) {
        const raw = values[key];
        if (!raw) continue;
        try {
          const value = object(JSON.parse(raw));
          if (value && (value.expire === null || value.expire === undefined
            || typeof value.expire === "number")) this.storage[key] = value;
        } catch { /* A corrupt cache is treated as an expired session. */ }
      }
    } catch {
      throw authRequired();
    }
  }

  private token(key: StorageKey, margin = 0): string | undefined {
    const stored = this.storage[key];
    if (!stored || (typeof stored.expire === "number" && stored.expire <= Date.now() + margin)) return;
    return typeof stored.value === "string" && stored.value ? stored.value : undefined;
  }

  private async save(values: Partial<Record<StorageKey, unknown>>): Promise<void> {
    const now = Date.now();
    const serialized: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      const storageKey = key as StorageKey;
      const entry = { value, time: now, expire: now + (key === "REFRESH_TOKEN" || key === "USER_INFO" ? 7 : 1) * DAY };
      this.storage[storageKey] = entry;
      serialized[key] = JSON.stringify(entry);
    }
    try {
      const saved = await this.session.page.evaluate(({ origin, entries }) => {
        if (location.origin !== origin) return false;
        for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
        return true;
      }, { origin: ORIGIN, entries: serialized });
      if (!saved) throw authRequired();
    } catch {
      throw authRequired();
    }
  }

  private async raw(path: string, token?: string, data?: JsonObject, rateLimitRetries = { count: 0 }): Promise<unknown> {
    const gameGet = path.startsWith("game/") && data === undefined;
    for (;;) {
      if (this.abort.signal.aborted) throw cancelled();
      if (gameGet) {
        const delay = this.lastGameRequestAt === undefined ? 0 : this.lastGameRequestAt + GAME_REQUEST_INTERVAL - Date.now();
        if (delay > 0) await this.wait(delay);
        this.lastGameRequestAt = Date.now();
      }
      try {
        return await this.send(path, token, data);
      } catch (error) {
        if (!gameGet || !(error instanceof GameRateLimit)) throw error;
        const delay = retryDelay(error.retryAfter, rateLimitRetries.count);
        if (rateLimitRetries.count >= MAX_RATE_LIMIT_RETRIES) throw rateLimited(delay);
        rateLimitRetries.count += 1;
        // send() disposes the response before this wait, including rate-limited responses.
        await this.wait(delay, true);
      }
    }
  }

  private async send(path: string, token?: string, data?: JsonObject): Promise<unknown> {
    let response;
    try {
      response = await this.session.context.request.fetch(`${ORIGIN}/api/${path}`, {
        method: data ? "POST" : "GET",
        headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(data ? { data } : {}),
        timeout: REQUEST_TIMEOUT,
        maxRedirects: 0,
        failOnStatusCode: false,
      });
    } catch {
      // Playwright exceptions can include request headers. Never propagate them to the UI/log.
      if (this.abort.signal.aborted) throw cancelled();
      throw new SyncError("UPSTREAM_ERROR", "大饼请求失败或超时，请稍后重试。");
    }
    try {
      const status = response.status();
      const gameRequest = path.startsWith("game/");
      if (status >= 300 && status < 400) {
        throw new SyncError("UPSTREAM_REDIRECT", "大饼接口发生重定向，已停止同步，请重新登录。");
      }
      if (status === 401) throw authRequired();
      if (status === 429 && gameRequest && data === undefined) {
        throw new GameRateLimit(response.headers()["retry-after"]);
      }
      if (status < 200 || status >= 300) throw new SyncError("UPSTREAM_ERROR", `大饼请求失败（HTTP ${status}）。`);
      if (gameRequest && status !== 200 && status !== 201 && status !== 204) {
        throw new SyncError("UPSTREAM_ERROR", `大饼成绩请求尚未完成（HTTP ${status}）。`);
      }
      let body: unknown;
      try { body = await response.json(); } catch { throw invalidResponse(); }
      const envelope = object(body);
      if (!envelope || !("data" in envelope)) throw invalidResponse();
      // The official game transport accepts HTTP 200/201/204 and returns data regardless
      // of envelope.code. Only the separate Aime transport uses code === 0 for success.
      // History parsing below still rejects missing, malformed, or partial data.
      if (!gameRequest) {
        if (envelope.code === 401) throw authRequired();
        if (envelope.code !== 0) throw invalidResponse();
      }
      return camelCase(envelope.data);
    } finally {
      await response.dispose().catch(() => undefined);
    }
  }

  private async refresh(): Promise<void> {
    const refreshToken = this.token("REFRESH_TOKEN");
    if (!refreshToken) throw authRequired();
    const result = object(await this.raw("aime/token/refresh", undefined, { refresh_token: refreshToken }));
    const tokens = object(result?.token);
    if (typeof tokens?.accessToken !== "string" || !tokens.accessToken) throw invalidResponse();
    const nextRefresh = typeof tokens.refreshToken === "string" && tokens.refreshToken ? tokens.refreshToken : refreshToken;
    const idToken = typeof tokens.idToken === "string" && tokens.idToken ? tokens.idToken : undefined;
    // Save the rotated refresh token even if the subsequent ID-token request fails.
    await this.save({ TOKEN: tokens.accessToken, REFRESH_TOKEN: nextRefresh, ID_TOKEN: idToken });
    if (!idToken) await this.updateIdToken();
  }

  private async updateIdToken(): Promise<void> {
    const token = this.token("TOKEN");
    if (!token) throw authRequired();
    const data = object(await this.raw("aime/token/id", token));
    if (typeof data?.idToken !== "string" || !data.idToken) throw invalidResponse();
    await this.save({ ID_TOKEN: data.idToken });
  }

  async get(path: string, key: TokenKey = "TOKEN"): Promise<unknown> {
    const rateLimitRetries = { count: 0 };
    let refreshed = false;
    if (!this.token(key, 60_000)) {
      if (key === "ID_TOKEN" && this.token("TOKEN", 60_000) && !this.token("REFRESH_TOKEN")) {
        await this.updateIdToken();
      } else {
        await this.refresh();
        refreshed = true;
      }
    }
    try {
      return await this.raw(path, this.token(key), undefined, rateLimitRetries);
    } catch (error) {
      if (!(error instanceof SyncError) || error.code !== "AUTH_REQUIRED" || refreshed) throw error;
      await this.refresh();
      return this.raw(path, this.token(key), undefined, rateLimitRetries);
    }
  }

  async identify(): Promise<SourceIdentity> {
    const response = object(await this.get("aime/user/me"));
    const user = object(response?.user);
    const id = identifier(user?.netId);
    if (!id) throw invalidResponse();
    const cards = await this.get("aime/card");
    if (!Array.isArray(cards)) throw invalidResponse();
    const mains = cards.map(object).filter((card) => card?.isMain === true);
    if (mains.length === 0) throw new SyncError("NO_MAIN_CARD", "请先在大饼官网指定用于同步的主卡。", 409);
    if (mains.length !== 1) throw invalidResponse();
    const main = mains[0];
    const cardId = identifier(main?.id);
    if (!cardId) throw invalidResponse();
    await this.save({ USER_INFO: user });
    const name = typeof user?.name === "string" && user.name.trim() ? user.name.trim() : `用户 ${id}`;
    return { id, cardId, label: `${name} · 主卡 ${cardId}` };
  }

  async renewCardToken(): Promise<void> {
    // A cached ID token may still address a previously selected card. Obtain a fresh token
    // for the verified current card without calling the upstream card-switch endpoint.
    const data = object(await this.get("aime/token/id"));
    if (typeof data?.idToken !== "string" || !data.idToken) throw invalidResponse();
    await this.save({ ID_TOKEN: data.idToken });
  }
}

interface ScoreCandidate extends ScoreAchievements {
  music: { name: string };
  difficulty: number;
  score: number;
}

function readPage(value: unknown, page: number): { entries: unknown[]; totalPage: number; total: number } {
  const result = object(value);
  const pagination = object(result?.pagination);
  const totalPage = pagination?.totalPage;
  const total = pagination?.total;
  // The history client uses local page state, so a response page field is optional.
  if (!Array.isArray(result?.data) || !Number.isSafeInteger(totalPage) || typeof totalPage !== "number"
    || totalPage < 0 || totalPage > MAX_PAGES || !Number.isSafeInteger(total) || typeof total !== "number" || total < 0
    || pagination?.page !== undefined && pagination.page !== page
    || pagination?.currentPage !== undefined && pagination.currentPage !== page
    || pagination?.perPage !== undefined && (!Number.isSafeInteger(pagination.perPage) || Number(pagination.perPage) <= 0)
    || page > Math.max(1, totalPage)
    || total === 0 && (totalPage > 1 || result.data.length !== 0)
    || total > 0 && (totalPage === 0 || result.data.length === 0)) {
    throw invalidResponse();
  }
  return { entries: result.data, totalPage, total };
}

interface HistoryEntry {
  timestamp: number;
  key: string;
  score: ScoreCandidate | null;
}

function historyChanged(): SyncError {
  return new SyncError("HISTORY_CHANGED", "大饼历史记录在同步期间发生变化，本次未导入成绩。请稍后重新同步。", 409);
}

function historyAnchorMissing(): SyncError {
  return new SyncError("HISTORY_ANCHOR_MISSING", "大饼历史记录中找不到上次同步的位置，可能已被截断或删除。请点击“全量校准”重新建立基线。本次未导入成绩。", 409);
}

function normalizeHistoryEntry(value: unknown): HistoryEntry {
  const record = object(value);
  const music = object(record?.music);
  const timestamp = record?.playDate;
  const difficulty = record?.difficulty;
  const score = record?.score;
  const track = record?.track;
  if (!record || typeof music?.name !== "string" || !music.name.trim()
    || typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) || timestamp < 0
    || typeof difficulty !== "number" || !Number.isInteger(difficulty) || difficulty < 0 || difficulty > 5
    || typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 1_010_000
    || track !== undefined && (typeof track !== "number" || !Number.isInteger(track) || track < 0)) throw invalidResponse();
  // Keep the fingerprint compatible with existing timestamp checkpoints. Repeated
  // rows can still carry stronger achievement metadata, which is merged separately.
  const key = createHash("sha256").update(JSON.stringify([
    timestamp, identifier(music.musicId) ?? null, music.name, difficulty, score, track ?? null,
  ])).digest("hex");
  return {
    timestamp, key,
    score: difficulty >= 2 && difficulty <= 4 ? {
      music: { name: music.name }, difficulty, score,
      ...readScoreAchievements(record, score),
    } : null,
  };
}

interface HistoryPage {
  entries: HistoryEntry[];
  totalPage: number;
  total: number;
}

async function historyPage(api: OtogameApi, page: number): Promise<HistoryPage> {
  // Match the official history client: supply only page and use the API's default size.
  const value = await api.get(`game/chunithm/playlog?page=${page}`, "ID_TOKEN");
  const result = readPage(value, page);
  const perPage = object(object(value)?.pagination)?.perPage;
  if (typeof perPage === "number" && result.total > 0
    && (result.entries.length > perPage
      || page < result.totalPage && result.entries.length !== perPage
      || page === result.totalPage && (page - 1) * perPage + result.entries.length !== result.total)) throw invalidResponse();
  const entries = result.entries.map(normalizeHistoryEntry);
  api.pageCompleted();
  return { entries, totalPage: result.totalPage, total: result.total };
}

function historyPageSignature(page: HistoryPage): string {
  return JSON.stringify([page.total, page.totalPage, page.entries.map((entry) => entry.key)]);
}

async function collectHistory(api: OtogameApi, checkpoint?: OtogameCheckpoint): Promise<{ scores: ScoreCandidate[]; checkpoint: OtogameCheckpoint }> {
  const first = await historyPage(api, 1);
  const latest = first.entries[0]?.timestamp ?? null;
  if (checkpoint?.timestamp !== undefined && checkpoint.timestamp !== null
    && (latest === null || latest < checkpoint.timestamp)) throw historyAnchorMissing();
  const originalBoundary = new Set(checkpoint?.boundaryKeys ?? []);
  if (checkpoint && checkpoint.timestamp !== null && originalBoundary.size === 0) throw invalidResponse();
  const seenOriginalBoundary = new Set<string>();
  const latestBoundary = new Set<string>();
  const scoredPlays = new Map<string, ScoreCandidate>();
  let previousTimestamp = Infinity;
  let finished = false;
  let readCount = 0;
  for (let page = 1; page <= Math.max(1, first.totalPage) && !finished; page += 1) {
    const current = page === 1 ? first : await historyPage(api, page);
    if (current.total !== first.total || current.totalPage !== first.totalPage) throw historyChanged();
    readCount += current.entries.length;
    for (const entry of current.entries) {
      if (entry.timestamp > previousTimestamp) throw historyChanged();
      previousTimestamp = entry.timestamp;
      if (entry.timestamp === latest) latestBoundary.add(entry.key);
      // Without a checkpoint, read the entire retained history. Later syncs stop
      // only after the previous boundary second, including new plays in that second.
      if (checkpoint && checkpoint.timestamp !== null && entry.timestamp < checkpoint.timestamp) {
        finished = true;
        continue;
      }
      if (entry.timestamp === checkpoint?.timestamp && originalBoundary.has(entry.key)) {
        seenOriginalBoundary.add(entry.key);
      } else if (entry.score) {
        scoredPlays.set(entry.key, {
          ...entry.score,
          ...mergeScoreAchievements(scoredPlays.get(entry.key) ?? {}, entry.score),
        });
      }
    }
  }
  if (!finished && readCount !== first.total) throw invalidResponse();
  if (checkpoint?.timestamp !== undefined && checkpoint.timestamp !== null
    && [...originalBoundary].some((key) => !seenOriginalBoundary.has(key))) throw historyAnchorMissing();
  // Offset pagination has no snapshot token. Re-read the head before advancing
  // the cursor so new plays shifting page offsets cannot silently skip a row.
  const confirmed = await historyPage(api, 1);
  if (historyPageSignature(confirmed) !== historyPageSignature(first)) throw historyChanged();
  return { scores: [...scoredPlays.values()], checkpoint: { timestamp: latest, boundaryKeys: [...latestBoundary].sort() } };
}

export const otogameProvider: BrowserProvider = {
  source: "otogame",
  loginUrl: `${ORIGIN}/auth/login`,
  async identify(session) {
    const api = new OtogameApi(session);
    try {
      await api.restore();
      return await api.identify();
    } finally {
      api.dispose();
    }
  },
  async fetchScores(session, identity, reportProgress?: ProgressReporter) {
    const api = new OtogameApi(session, reportProgress);
    try {
      await api.restore();
      requireIdentity(await api.identify(), identity);
      await api.renewCardToken();
      const { scores } = await collectHistory(api);
      requireIdentity(await api.identify(), identity);
      return scores;
    } finally {
      api.dispose();
    }
  },
  async fetchScoreChanges(session, identity, checkpoint, reportProgress?: ProgressReporter) {
    const api = new OtogameApi(session, reportProgress);
    try {
      await api.restore();
      requireIdentity(await api.identify(), identity);
      await api.renewCardToken();
      const history = await collectHistory(api, checkpoint);
      // Account/main-card changes invalidate both the scores and the new cursor.
      requireIdentity(await api.identify(), identity);
      return { payload: history.scores, checkpoint: history.checkpoint };
    } finally {
      api.dispose();
    }
  },
};
