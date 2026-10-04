import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { BrowserSession, OtogameCheckpoint } from "../provider";
import type { SyncProgress } from "../../src/syncTypes";
import { otogameProvider } from "./otogame";

const ORIGIN = "https://u.otogame.net";
const identity = { id: "42", cardId: "7", label: "Player · 主卡 7" };
type RequestOptions = { method: string; headers: Record<string, string>; data?: unknown; maxRedirects: number; timeout: number };
type Reply = { status?: number; data?: unknown; code?: number | string | null; jsonError?: boolean; headers?: Record<string, string> };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T14:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

async function collectScores(session: BrowserSession, expected = identity, reportProgress?: (progress: SyncProgress) => void): Promise<unknown> {
  // Attach both handlers immediately so errors raised while fake timers run are observed.
  const result = otogameProvider.fetchScores(session, expected, reportProgress).then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
  await vi.runAllTimersAsync();
  const settled = await result;
  if (settled.error) throw settled.error;
  return settled.value;
}

async function collectChanges(session: BrowserSession, checkpoint?: OtogameCheckpoint, expected = identity) {
  const result = otogameProvider.fetchScoreChanges!(session, expected, checkpoint).then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
  await vi.runAllTimersAsync();
  const settled = await result;
  if (settled.error) throw settled.error;
  return settled.value!;
}

function play(title: string, timestamp: number, difficulty = 3, score = 1_005_000, track = 1) {
  return { music: { music_id: title, name: title }, play_date: timestamp, difficulty, score, track };
}

async function checkpointFor(entries: unknown[]) {
  const { session } = setup((path) => path.startsWith("game/chunithm/playlog?") ? pageReply(entries) : undefined);
  return (await collectChanges(session)).checkpoint;
}

function setup(handler?: (path: string, options: RequestOptions) => Reply | undefined) {
  const storage: Record<string, string> = {};
  const put = (key: string, value: unknown, expire = Date.now() + 3_600_000) => {
    storage[key] = JSON.stringify({ value, expire, time: Date.now() - 60_000 });
  };
  put("TOKEN", "access-secret");
  put("ID_TOKEN", "old-id-secret");
  put("REFRESH_TOKEN", "refresh-secret");
  put("USER_INFO", { netId: 999, name: "Stale user" });
  const gameRequests: Array<{ at: number; url: string }> = [];
  const disposals: Array<{ at: number; url: string; status: number }> = [];
  const fetch = vi.fn(async (url: string, options: RequestOptions) => {
    const path = url.slice(`${ORIGIN}/api/`.length);
    if (path.startsWith("game/")) gameRequests.push({ at: Date.now(), url });
    if (path.startsWith("game/") && !path.startsWith("game/chunithm/playlog?")) {
      throw new Error(`Unexpected non-history route ${path}`);
    }
    let response = handler?.(path, options);
    if (!response && path === "aime/user/me") response = { data: { user: { net_id: 42, name: "Player" } } };
    if (!response && path === "aime/card") response = { data: [{ id: 7, is_main: true, aime: { access_code: "12345678901234567890" } }] };
    if (!response && path === "aime/token/id") response = { data: { id_token: "current-id-secret" } };
    if (!response && path.startsWith("game/chunithm/playlog?")) response = { data: { data: [], pagination: { page: 1, total_page: 0, total: 0 } } };
    if (!response) throw new Error(`Unexpected route ${path}`);
    const result = response;
    return {
      status: () => result.status ?? 200,
      headers: () => result.headers ?? {},
      json: async () => {
        if (result.jsonError) throw new Error("secret upstream body");
        return { code: "code" in result ? result.code : 0, data: result.data };
      },
      dispose: vi.fn(async () => { disposals.push({ at: Date.now(), url, status: result.status ?? 200 }); }),
    };
  });
  const evaluate = vi.fn(async (_fn: unknown, options: { origin: string; keys?: string[]; entries?: Record<string, string> }) => {
    expect(options.origin).toBe(ORIGIN);
    if (options.keys) return Object.fromEntries(options.keys.map((key) => [key, storage[key] ?? null]));
    Object.assign(storage, options.entries);
    return true;
  });
  const context = Object.assign(new EventEmitter(), { request: { fetch } });
  const session = { page: { evaluate }, context } as unknown as BrowserSession;
  return { session, fetch, evaluate, storage, put, gameRequests, disposals, context };
}

function pageReply(entries: unknown[], page = 1, total = entries.length): Reply {
  return { data: { data: entries, pagination: { page, per_page: 20, total_page: Math.ceil(total / 20), total } } };
}

describe("Otogame browser provider", () => {
  it("verifies the account and current main card from the API instead of cached USER_INFO", async () => {
    const { session, fetch, storage } = setup();
    await expect(otogameProvider.identify(session)).resolves.toEqual(identity);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${ORIGIN}/api/aime/user/me`, `${ORIGIN}/api/aime/card`,
    ]);
    expect(JSON.parse(storage.USER_INFO).value.netId).toBe(42);
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer access-secret");
  });

  it("fetches all retained history pages for EXP/MAS/ULT and confirms the head", async () => {
    const first = Array.from({ length: 20 }, (_, i) => play(`EXP ${i}`, 200 - i, 2));
    const last = [play("MAS played", 100), play("ULT zero", 99, 4, 0), play("Basic", 98, 0)];
    const { session, fetch } = setup((path) => {
      if (!path.startsWith("game/")) return;
      const page = Number(new URL(`${ORIGIN}/${path}`).searchParams.get("page"));
      return pageReply(page === 1 ? first : last, page, 23);
    });
    const scores = await collectScores(session, identity) as unknown[];
    expect(scores).toHaveLength(22);
    expect(scores[19]).toEqual({ music: { name: "EXP 19" }, difficulty: 2, score: 1_005_000 });
    expect(scores[20]).toEqual({ music: { name: "MAS played" }, difficulty: 3, score: 1_005_000 });
    expect(scores[21]).toEqual({ music: { name: "ULT zero" }, difficulty: 4, score: 0 });
    const gameCalls = fetch.mock.calls.filter(([url]) => url.includes("/game/"));
    expect(gameCalls.map(([url]) => {
      expect(new URL(url).pathname).toBe("/api/game/chunithm/playlog");
      return new URL(url).searchParams.toString();
    })).toEqual(["page=1", "page=2", "page=1"]);
    for (const [, options] of gameCalls) expect(options.headers.Authorization).toBe("Bearer current-id-secret");
    for (const [, options] of fetch.mock.calls) {
      expect(options.maxRedirects).toBe(0);
      expect(options.timeout).toBe(20_000);
      expect(options.method).toBe("GET");
    }
  });

  it("collects older repeats so a higher historical score remains available to the merger", async () => {
    const first = Array.from({ length: 20 }, (_, index) => play("Repeated", 200 - index, 2, 1_005_000));
    const { session, gameRequests } = setup((path) => {
      if (!path.startsWith("game/")) return;
      const page = Number(new URL(`${ORIGIN}/${path}`).searchParams.get("page"));
      return pageReply(page === 1 ? first : [play("Repeated", 100, 2, 1_007_500)], page, 21);
    });
    const scores = await collectScores(session, identity) as Array<{ score: number }>;
    expect(scores).toHaveLength(21);
    expect(Math.max(...scores.map(({ score }) => score))).toBe(1_007_500);
    expect(gameRequests.map(({ url }) => new URL(url).searchParams.toString()))
      .toEqual(["page=1", "page=2", "page=1"]);
  });

  it("rejects a later history page failure instead of returning collected scores", async () => {
    const { session, fetch } = setup((path) => {
      if (!path.startsWith("game/")) return;
      if (path.endsWith("page=1")) return pageReply(Array.from({ length: 20 }, (_, i) => play(`EXP ${i}`, 200 - i, 2)), 1, 21);
      return { status: 503 };
    });
    await expect(collectScores(session, identity)).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(fetch.mock.calls.filter(([url]) => url.includes("/game/"))).toHaveLength(2);
  });

  it("spaces every read-only game request start by at least 1100ms", async () => {
    const { session, gameRequests } = setup();
    const start = Date.now();
    await collectScores(session, identity);
    expect(gameRequests.map((request) => request.at - start)).toEqual([0, 1100]);
  });

  it("retries the same limited history page after disposal without duplicating earlier plays", async () => {
    let attempts = 0;
    const { session, gameRequests, disposals } = setup((path) => {
      if (!path.startsWith("game/")) return;
      if (path.endsWith("page=1")) return pageReply(Array.from({ length: 20 }, (_, i) => play(`Song ${i}`, 200 - i, 2)), 1, 21);
      if (++attempts === 1) return { status: 429, code: "429" };
      return pageReply([play("Last song", 100, 2)], 2, 21);
    });
    const start = Date.now();
    const scores = await collectScores(session, identity) as unknown[];
    expect(scores).toHaveLength(21);
    expect(scores.filter((score) => JSON.stringify(score).includes("Last song"))).toHaveLength(1);
    expect(gameRequests.map((request) => request.at - start)).toEqual([0, 1100, 3100, 4200]);
    expect(gameRequests[1].url).toBe(gameRequests[2].url);
    expect(disposals.find((response) => response.status === 429)?.at).toBe(start + 1100);
  });

  it("backs off 2/4/8 seconds without Retry-After and limits retries to three", async () => {
    let attempts = 0;
    const recovering = setup((path) => {
      if (path.startsWith("game/") && ++attempts <= 3) return { status: 429 };
    });
    const start = Date.now();
    await expect(collectScores(recovering.session, identity)).resolves.toEqual([]);
    expect(recovering.gameRequests.slice(0, 4).map((request) => request.at - start)).toEqual([0, 2000, 6000, 14000]);

    const exhausted = setup((path) => {
      if (!path.startsWith("game/")) return;
      if (path.endsWith("page=1")) return pageReply(Array.from({ length: 20 }, (_, i) => play(`Song ${i}`, 200 - i, 2)), 1, 21);
      return { status: 429 };
    });
    await expect(collectScores(exhausted.session, identity)).rejects.toMatchObject({ code: "RATE_LIMITED", status: 429 });
    expect(exhausted.gameRequests).toHaveLength(5);
    expect(exhausted.gameRequests.every((request) => new URL(request.url).pathname === "/api/game/chunithm/playlog")).toBe(true);
    expect(exhausted.disposals.filter((response) => response.status === 429)).toHaveLength(4);
  });

  it.each(["seconds", "HTTP date"])("honors Retry-After expressed as %s", async (format) => {
    const start = Date.now();
    let attempts = 0;
    const { session, gameRequests } = setup((path) => {
      if (path.startsWith("game/") && ++attempts === 1) return {
        status: 429,
        headers: { "retry-after": format === "seconds" ? "5" : new Date(start + 5000).toUTCString() },
      };
    });
    await collectScores(session, identity);
    expect(gameRequests[1].at - gameRequests[0].at).toBe(5000);
  });

  it("waits the full 409-second cooldown, reports progress, and continues the same page", async () => {
    const start = Date.now();
    let attempts = 0;
    const { session, gameRequests, disposals, context } = setup((path) => path.startsWith("game/") && ++attempts === 1
      ? { status: 429, code: "429", headers: { "retry-after": "409" } } : undefined);
    const reportProgress = vi.fn();
    await expect(collectScores(session, identity, reportProgress)).resolves.toEqual([]);
    expect(gameRequests[1].at - gameRequests[0].at).toBe(409_000);
    expect(gameRequests[1].url).toBe(gameRequests[0].url);
    expect(disposals.find((response) => response.status === 429)?.at).toBe(start);
    expect(reportProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { completedPages: 0, retryAt: new Date(start + 409_000).toISOString() },
      { completedPages: 0, retryAt: null },
      { completedPages: 1, retryAt: null },
      { completedPages: 2, retryAt: null },
    ]);
    expect(context.listenerCount("close")).toBe(0);
  });

  it.each(["seconds", "HTTP date"])("refuses a cooldown longer than 15 minutes expressed as %s", async (format) => {
    const start = Date.now();
    const { session, gameRequests, disposals, context } = setup((path) => path.startsWith("game/")
      ? { status: 429, headers: { "retry-after": format === "seconds" ? "901" : new Date(start + 901_000).toUTCString() } } : undefined);
    const reportProgress = vi.fn();
    await expect(collectScores(session, identity, reportProgress)).rejects.toMatchObject({
      code: "RATE_LIMITED", status: 429, message: "大饼请求过于频繁，请等待至少 901 秒后重试。本次同步未导入。",
    });
    expect(gameRequests).toHaveLength(1);
    expect(disposals.filter((response) => response.status === 429)).toHaveLength(1);
    expect(Date.now()).toBe(start);
    expect(reportProgress).not.toHaveBeenCalled();
    expect(context.listenerCount("close")).toBe(0);
  });

  it("shares the 35-minute wait budget across successful history pages without returning partial scores", async () => {
    let headReads = 0;
    const attempted = new Set<string>();
    const { session, gameRequests, context } = setup((path) => {
      if (!path.startsWith("game/")) return;
      if (path.endsWith("page=1")) headReads += 1;
      if (!attempted.has(path) || path.endsWith("page=1") && headReads === 3) {
        attempted.add(path);
        return { status: 429, headers: { "retry-after": "900" } };
      }
      const page = Number(new URL(`${ORIGIN}/${path}`).searchParams.get("page"));
      return { data: {
        data: [play(`Song ${page}`, 100 - page, 2)],
        pagination: { total: 2, total_page: 2, page, per_page: 1 },
      } };
    });
    const reportProgress = vi.fn();
    await expect(collectScores(session, identity, reportProgress)).rejects.toMatchObject({
      code: "RATE_LIMITED", message: "大饼本次同步的累计等待将超过 35 分钟，请稍后重试。本次未导入成绩。",
    });
    expect(gameRequests).toHaveLength(5);
    expect(reportProgress.mock.calls.at(-1)?.[0]).toEqual({ completedPages: 2, retryAt: null });
    expect(reportProgress.mock.calls.filter(([progress]) => progress.retryAt)).toHaveLength(2);
    expect(context.listenerCount("close")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["cooldown", "throttle"])("immediately cancels a %s wait when the browser context closes", async (kind) => {
    const start = Date.now();
    const { session, context, gameRequests } = setup((path) => path.startsWith("game/") && kind === "cooldown"
      ? { status: 429, headers: { "retry-after": "409" } } : undefined);
    const reportProgress = vi.fn();
    const pending = otogameProvider.fetchScores(session, identity, reportProgress).then(
      () => null, (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(gameRequests).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    context.emit("close");
    await expect(pending).resolves.toMatchObject({ code: "SYNC_CANCELLED" });
    expect(vi.getTimerCount()).toBe(0);
    expect(context.listenerCount("close")).toBe(0);
    expect(Date.now()).toBe(start);
    expect(reportProgress.mock.calls.at(-1)?.[0].retryAt).toBeNull();
    expect(gameRequests).toHaveLength(1);
  });

  it("does not retry Aime requests or token refresh POSTs when they return 429", async () => {
    const limited = setup((path) => path === "aime/user/me" ? { status: 429 } : undefined);
    await expect(otogameProvider.identify(limited.session)).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(limited.fetch).toHaveBeenCalledTimes(1);
    const refresh = setup((path) => path === "aime/token/refresh" ? { status: 429 } : undefined);
    refresh.put("TOKEN", "expired", Date.now() - 1);
    await expect(otogameProvider.identify(refresh.session)).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(refresh.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([200, 201, 204])("uses the official game HTTP success contract for status %i", async (status) => {
    const { session } = setup((path) => {
      if (!path.startsWith("game/")) return;
      return { ...pageReply([play("Chart", 100, 3)]), status, code: null };
    });
    const scores = await collectScores(session, identity) as unknown[];
    expect(scores).toHaveLength(1);
  });

  it("follows every retained history page and confirms the head after a large initial import", async () => {
    const { session, fetch } = setup((path) => {
      if (!path.startsWith("game/")) return;
      const page = Number(new URL(`${ORIGIN}/${path}`).searchParams.get("page"));
      const total = 1686;
      const entries = Array.from({ length: Math.min(20, total - (page - 1) * 20) }, (_, index) =>
        play(`Synthetic ${page}-${index}`, 2000 - ((page - 1) * 20 + index), index % 6));
      return { status: 200, code: "ok", data: {
        data: entries,
        pagination: { total, page, per_page: 20, total_page: 85 },
      } };
    });
    const scores = await collectScores(session, identity) as unknown[];
    expect(scores).toHaveLength(759);
    expect(scores.at(-1)).toEqual({ music: { name: "Synthetic 85-4" }, difficulty: 4, score: 1_005_000 });
    const gameCalls = fetch.mock.calls.filter(([url]) => url.includes("/game/"));
    expect(gameCalls).toHaveLength(86);
    for (const [url] of gameCalls) {
      expect(new URL(url).pathname).toBe("/api/game/chunithm/playlog");
      expect(new URL(url).searchParams.has("per_page")).toBe(false);
    }
    expect(gameCalls.map(([url]) => Number(new URL(url).searchParams.get("page"))))
      .toEqual([...Array.from({ length: 85 }, (_, index) => index + 1), 1]);
  });

  it("still rejects an Aime response without its numeric success code", async () => {
    const { session } = setup((path) => path === "aime/user/me"
      ? { code: null, data: { user: { net_id: 42, name: "Player" } } } : undefined);
    await expect(otogameProvider.identify(session)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("does not mistake HTTP 200 game errors or pending responses for score pages", async () => {
    const malformed = setup((path) => path.startsWith("game/") ? { code: "form-02", data: null } : undefined);
    await expect(collectScores(malformed.session, identity)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    const pending = setup((path) => path.startsWith("game/")
      ? { ...pageReply([play("Chart", 100, 2)]), status: 202 } : undefined);
    await expect(collectScores(pending.session, identity)).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("accepts an optional page field and an API-selected page size", async () => {
    const { session, fetch } = setup((path) => {
      if (!path.startsWith("game/")) return;
      const page = Number(new URL(`${ORIGIN}/${path}`).searchParams.get("page"));
      return { data: {
        data: page === 1 ? [play("First", 100, 2), play("Second", 99)] : [play("Third", 98, 4)],
        pagination: { total: 3, total_page: 2, per_page: 2, ...(page === 2 ? { current_page: 2 } : {}) },
      } };
    });
    const scores = await collectScores(session, identity) as unknown[];
    expect(scores).toHaveLength(3);
    expect(fetch.mock.calls.filter(([url]) => url.includes("/game/"))).toHaveLength(3);
  });

  it("rejects changed pagination totals after an earlier page was collected", async () => {
    const { session } = setup((path) => {
      if (!path.startsWith("game/")) return;
      const page = Number(new URL(`${ORIGIN}/${path}`).searchParams.get("page"));
      return { data: {
        data: [play(`EXP ${page}`, 100 - page, 2)],
        pagination: { total: page === 1 ? 2 : 3, total_page: 2 },
      } };
    });
    await expect(collectScores(session, identity)).rejects.toMatchObject({ code: "HISTORY_CHANGED" });
  });

  it("refuses a changed main card without switching cards or reading scores", async () => {
    const { session, fetch } = setup((path) => path === "aime/card" ? { data: [{ id: 8, is_main: true }] } : undefined);
    await expect(collectScores(session, identity)).rejects.toMatchObject({ code: "IDENTITY_CHANGED" });
    expect(fetch.mock.calls.every(([url, options]) => !url.includes("/game/") && options.method === "GET")).toBe(true);
  });

  it("rejects account or card changes detected after collection", async () => {
    let cardReads = 0;
    const { session } = setup((path) => path === "aime/card"
      ? { data: [{ id: ++cardReads === 1 ? 7 : 8, is_main: true }] } : undefined);
    await expect(collectScores(session, identity)).rejects.toMatchObject({ code: "IDENTITY_CHANGED" });
    const otherUser = setup((path) => path === "aime/user/me" ? { data: { user: { net_id: 55, name: "Other" } } } : undefined);
    await expect(collectScores(otherUser.session, identity)).rejects.toMatchObject({ code: "IDENTITY_CHANGED" });
  });

  it("restores expired wrapped tokens with refresh_token and saves rotated tokens for future sessions", async () => {
    const { session, fetch, storage, put } = setup((path) => path === "aime/token/refresh"
      ? { data: { token: { access_token: "new-access", refresh_token: "new-refresh", id_token: "new-id" } } } : undefined);
    put("TOKEN", "expired-access", Date.now() - 1);
    put("ID_TOKEN", "expired-id", Date.now() - 1);
    await expect(otogameProvider.identify(session)).resolves.toEqual(identity);
    const refreshCall = fetch.mock.calls.find(([url]) => url.endsWith("/token/refresh"));
    expect(refreshCall?.[1]).toMatchObject({ method: "POST", data: { refresh_token: "refresh-secret" }, maxRedirects: 0 });
    expect(refreshCall?.[1].headers.Authorization).toBeUndefined();
    expect(JSON.parse(storage.TOKEN).value).toBe("new-access");
    expect(JSON.parse(storage.ID_TOKEN).value).toBe("new-id");
    expect(JSON.parse(storage.REFRESH_TOKEN).value).toBe("new-refresh");
    await otogameProvider.identify(session);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/token/refresh"))).toHaveLength(1);
  });

  it("obtains a separate ID token when refresh omits it", async () => {
    const { session, storage, put } = setup((path) => path === "aime/token/refresh"
      ? { data: { token: { access_token: "new-access" } } } : undefined);
    put("TOKEN", "expired", Date.now() - 1);
    await otogameProvider.identify(session);
    expect(JSON.parse(storage.ID_TOKEN).value).toBe("current-id-secret");
    expect(JSON.parse(storage.REFRESH_TOKEN).value).toBe("refresh-secret");
  });

  it("refreshes and retries an unauthorized request only once", async () => {
    let userReads = 0;
    const { session, fetch } = setup((path) => {
      if (path === "aime/user/me" && ++userReads === 1) return { status: 401 };
      if (path === "aime/token/refresh") return { data: { token: { access_token: "new-access", id_token: "new-id" } } };
    });
    await expect(otogameProvider.identify(session)).resolves.toEqual(identity);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/user/me"))).toHaveLength(2);
    const failing = setup((path) => {
      if (path === "aime/user/me") return { status: 401 };
      if (path === "aime/token/refresh") return { data: { token: { access_token: "still-bad", id_token: "still-bad-id" } } };
    });
    await expect(otogameProvider.identify(failing.session)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(failing.fetch.mock.calls.filter(([url]) => url.endsWith("/token/refresh"))).toHaveLength(1);
  });

  it("does not refresh an expired refresh token or rely on an unwrapped token", async () => {
    const { session, put, storage, fetch } = setup();
    storage.TOKEN = '"plain-access"';
    put("REFRESH_TOKEN", "expired-refresh", Date.now() - 1);
    await expect(otogameProvider.identify(session)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects redirects and hides potentially sensitive transport exceptions", async () => {
    const redirected = setup(() => ({ status: 302 }));
    await expect(otogameProvider.identify(redirected.session)).rejects.toMatchObject({ code: "UPSTREAM_REDIRECT" });
    expect(redirected.fetch).toHaveBeenCalledTimes(1);
    const failing = setup(() => { throw new Error("Authorization: Bearer secret-token"); });
    await expect(otogameProvider.identify(failing.session)).rejects.toThrow("大饼请求失败或超时");
  });

  it.each([
    { data: [], pagination: { page: 1, per_page: 20, total_page: -1, total: 0 } },
    { data: [], pagination: { page: 1, per_page: 20, total_page: 9000, total: 180000 } },
    { data: [], pagination: { page: 2, per_page: 20, total_page: 0, total: 0 } },
    { data: [], pagination: { page: 1, per_page: 20, total_page: 2, total: 21 } },
    { data: [], pagination: { current_page: 2, total_page: 0, total: 0 } },
    { data: [], pagination: { per_page: 0, total_page: 0, total: 0 } },
  ])("rejects invalid or incomplete pagination %#", async (data) => {
    const { session } = setup((path) => path.startsWith("game/") ? { data } : undefined);
    await expect(collectScores(session, identity)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it.each([
    { ...play("Bad", 100, 2), score: 1_010_001 },
    { ...play("Bad", 100, 2), score: { score_max: 1_000_000 } },
    { ...play("Bad", 100, 2), difficulty: 6 },
    { ...play("Bad", 100, 2), music: {} },
    { ...play("Bad", 100, 2), score: null },
  ])("rejects malformed history entries during initial full import %#", async (record) => {
    const { session } = setup((path) => path.startsWith("game/") ? pageReply([record]) : undefined);
    await expect(collectScores(session, identity)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

});

describe("Otogame incremental history", () => {
  it("builds the initial baseline only from every retained history page", async () => {
    const first = Array.from({ length: 20 }, (_, index) => play(`Recent ${index}`, 200 - index, 2));
    const { session, fetch } = setup((path) => {
      if (!path.startsWith("game/")) return;
      const page = Number(new URL(`${ORIGIN}/${path}`).searchParams.get("page"));
      return pageReply(page === 1 ? first : [play("Older", 100, 4, 1_008_000)], page, 21);
    });
    const result = await collectChanges(session);
    expect(result.payload).toHaveLength(21);
    expect((result.payload as unknown[]).at(-1)).toEqual({ music: { name: "Older" }, difficulty: 4, score: 1_008_000 });
    expect(result.checkpoint.timestamp).toBe(200);
    expect(result.checkpoint.boundaryKeys).toHaveLength(1);
    expect(result.checkpoint.boundaryKeys[0]).toMatch(/^[a-f0-9]{64}$/);
    const gameCalls = fetch.mock.calls.filter(([url]) => url.includes("/game/"));
    expect(gameCalls.map(([url]) => new URL(url).searchParams.toString())).toEqual(["page=1", "page=2", "page=1"]);
    for (const [url, options] of gameCalls) {
      expect(new URL(url).pathname).toBe("/api/game/chunithm/playlog");
      expect(options.headers.Authorization).toBe("Bearer current-id-secret");
    }
  });

  it("rejects newly inserted plays during a full history import before committing its baseline", async () => {
    let reads = 0;
    const { session } = setup((path) => path.startsWith("game/chunithm/playlog?")
      ? pageReply(++reads === 1 ? [play("Initial", 100)] : [play("Later", 200), play("Initial", 100)]) : undefined);
    await expect(collectChanges(session)).rejects.toMatchObject({ code: "HISTORY_CHANGED" });
    expect(reads).toBe(2);
    const stable = setup((path) => path.startsWith("game/chunithm/playlog?")
      ? pageReply([play("Later", 200, 3, 1_009_000), play("Initial", 100)]) : undefined);
    const result = await collectChanges(stable.session);
    expect(result.checkpoint.timestamp).toBe(200);
    expect(result.payload).toHaveLength(2);
  });

  it("only reads history after initialization, collecting newer and unseen same-second plays", async () => {
    const checkpoint = await checkpointFor([play("A", 100), play("B", 100), play("Old", 90)]);
    const { session, fetch } = setup((path) => path.startsWith("game/chunithm/playlog?")
      ? pageReply([play("Newest", 200, 2, 1_008_000), play("B", 100), play("C", 100, 4, 1_006_000), play("A", 100), play("Old", 90)]) : undefined);
    const result = await collectChanges(session, checkpoint);
    expect(result.payload).toEqual([
      { music: { name: "Newest" }, difficulty: 2, score: 1_008_000 },
      { music: { name: "C" }, difficulty: 4, score: 1_006_000 },
    ]);
    expect(result.checkpoint.timestamp).toBe(200);
    expect(result.checkpoint.boundaryKeys).toHaveLength(1);
    expect(fetch.mock.calls.some(([url]) => url.includes("/chunithm/record"))).toBe(false);
    expect(checkpoint.timestamp).toBe(100);
    expect(checkpoint.boundaryKeys).toHaveLength(2);
  });

  it("reads every page containing the boundary second and stops before older pages", async () => {
    const checkpoint = await checkpointFor([play("Anchor", 100)]);
    const newest = Array.from({ length: 20 }, (_, index) => play(`New ${index}`, 200 - index));
    const { session, fetch } = setup((path) => {
      if (!path.startsWith("game/chunithm/playlog?")) return;
      const page = Number(new URL(`${ORIGIN}/${path}`).searchParams.get("page"));
      const rows = page === 1 ? newest : page === 2
        ? [play("Anchor", 100), ...Array.from({ length: 19 }, (_, index) => play(`Same ${index}`, 100))]
        : [play("Last same", 100, 4), ...Array.from({ length: 19 }, (_, index) => play(`Old ${index}`, 99 - index))];
      return pageReply(rows, page, 80);
    });
    const result = await collectChanges(session, checkpoint);
    expect(result.payload).toHaveLength(40);
    expect((result.payload as Array<{ music: { name: string } }>).at(-1)?.music.name).toBe("Last same");
    expect(fetch.mock.calls.filter(([url]) => url.includes("playlog")).map(([url]) => new URL(url).searchParams.get("page")))
      .toEqual(["1", "2", "3", "1"]);
    expect(result.checkpoint.boundaryKeys).toHaveLength(1);
  });

  it("captures a newest-second boundary that spans several pages during initialization", async () => {
    const { session } = setup((path) => {
      if (!path.startsWith("game/chunithm/playlog?")) return;
      const page = Number(new URL(`${ORIGIN}/${path}`).searchParams.get("page"));
      return pageReply(page === 1 ? Array.from({ length: 20 }, (_, index) => play(`Same ${index}`, 100))
        : [play("Last same", 100), play("Older", 99)], page, 22);
    });
    const result = await collectChanges(session);
    expect(result.payload).toHaveLength(22);
    expect((result.payload as Array<{ music: { name: string } }>).at(-1)?.music.name).toBe("Older");
    expect(result.checkpoint.boundaryKeys).toHaveLength(21);
  });

  it("returns no new scores and reads only the head when history has not changed", async () => {
    const rows = [play("A", 100), play("B", 100), play("Old", 99)];
    const checkpoint = await checkpointFor(rows);
    const { session, fetch } = setup((path) => path.startsWith("game/chunithm/playlog?") ? pageReply(rows) : undefined);
    const result = await collectChanges(session, checkpoint);
    expect(result.payload).toEqual([]);
    expect(result.checkpoint).toEqual(checkpoint);
    expect(fetch.mock.calls.filter(([url]) => url.includes("/game/"))).toHaveLength(2);
  });

  it("handles an initially empty history without requesting a score table", async () => {
    const initial = setup();
    const result = await collectChanges(initial.session);
    expect(result.checkpoint).toEqual({ timestamp: null, boundaryKeys: [] });
    expect(initial.fetch.mock.calls.some(([url]) => url.includes("/record"))).toBe(false);
    const unchanged = setup();
    expect(await collectChanges(unchanged.session, result.checkpoint)).toEqual({
      payload: [], checkpoint: { timestamp: null, boundaryKeys: [] },
    });
    expect(unchanged.fetch.mock.calls.some(([url]) => url.includes("/record"))).toBe(false);
    const later = setup((path) => path.startsWith("game/chunithm/playlog?")
      ? pageReply([play("New", 100), play("Older new", 90)]) : undefined);
    expect((await collectChanges(later.session, result.checkpoint)).payload).toHaveLength(2);
  });

  it("anchors on BASIC/ADVANCE/WORLD'S END plays while importing only EXP/MAS/ULT", async () => {
    const checkpoint = await checkpointFor([play("Basic anchor", 100, 0)]);
    const { session } = setup((path) => path.startsWith("game/chunithm/playlog?") ? pageReply([
      play("Worlds end", 200, 5), play("Advance", 190, 1), play("EXP", 180, 2),
      play("MAS", 170, 3), play("ULT", 160, 4), play("Basic anchor", 100, 0),
    ]) : undefined);
    const result = await collectChanges(session, checkpoint);
    expect((result.payload as Array<{ difficulty: number }>).map((entry) => entry.difficulty)).toEqual([2, 3, 4]);
    expect(result.checkpoint.timestamp).toBe(200);
  });

  it("skips indistinguishable duplicate plays without duplicating imported candidates", async () => {
    const checkpoint = await checkpointFor([play("Anchor", 100)]);
    const { session } = setup((path) => path.startsWith("game/chunithm/playlog?")
      ? pageReply([play("New", 200), play("New", 200), play("Anchor", 100), play("Anchor", 100)]) : undefined);
    const result = await collectChanges(session, checkpoint);
    expect(result.payload).toHaveLength(1);
    expect(result.checkpoint.boundaryKeys).toHaveLength(1);
  });

  it("deduplicates identical historical plays during the initial full import", async () => {
    const { session } = setup((path) => path.startsWith("game/chunithm/playlog?")
      ? pageReply([play("Repeated", 200), play("Repeated", 200), play("Older", 100, 2)]) : undefined);
    const result = await collectChanges(session);
    expect(result.payload).toEqual([
      { music: { name: "Repeated" }, difficulty: 3, score: 1_005_000 },
      { music: { name: "Older" }, difficulty: 2, score: 1_005_000 },
    ]);
    expect(result.checkpoint.boundaryKeys).toHaveLength(1);
  });

  it.each(["within a page", "across pages"])("rejects timestamp order changes during initial full import %s", async (kind) => {
    const { session } = setup((path) => {
      if (!path.startsWith("game/chunithm/playlog?")) return;
      const page = Number(new URL(`${ORIGIN}/${path}`).searchParams.get("page"));
      if (kind === "within a page") return pageReply([play("New", 190), play("Newer", 200)]);
      return pageReply(page === 1 ? Array.from({ length: 20 }, (_, index) => play(`New ${index}`, 200 - index))
        : [play("Out of order", 190)], page, 21);
    });
    await expect(collectChanges(session)).rejects.toMatchObject({ code: "HISTORY_CHANGED" });
  });

  it("validates older historical entries before committing an initial baseline", async () => {
    const { session, gameRequests } = setup((path) => {
      if (!path.startsWith("game/chunithm/playlog?")) return;
      const page = Number(new URL(`${ORIGIN}/${path}`).searchParams.get("page"));
      return pageReply(page === 1 ? Array.from({ length: 20 }, (_, index) => play(`New ${index}`, 200 - index))
        : [{ ...play("Malformed old play", 100), score: null }], page, 21);
    });
    await expect(collectChanges(session)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(gameRequests.map(({ url }) => new URL(url).searchParams.get("page"))).toEqual(["1", "2"]);
  });

  it.each(["empty", "all older", "same-second missing anchor"])("rejects a %s history instead of advancing a lost anchor", async (kind) => {
    const checkpoint = await checkpointFor([play("Anchor", 100), play("Other anchor", 100)]);
    const rows = kind === "empty" ? [] : kind === "all older" ? [play("Old", 90)]
      : [play("New", 200), play("Anchor", 100), play("Old", 90)];
    const { session, fetch } = setup((path) => path.startsWith("game/chunithm/playlog?") ? pageReply(rows) : undefined);
    await expect(collectChanges(session, checkpoint)).rejects.toMatchObject({ code: "HISTORY_ANCHOR_MISSING", status: 409 });
    expect(checkpoint.timestamp).toBe(100);
    expect(fetch.mock.calls.some(([url]) => url.includes("/record"))).toBe(false);
  });

  it.each(["within a page", "across pages"])("rejects timestamp order changes %s", async (kind) => {
    const checkpoint = await checkpointFor([play("Anchor", 100)]);
    const { session } = setup((path) => {
      if (!path.startsWith("game/chunithm/playlog?")) return;
      const page = Number(new URL(`${ORIGIN}/${path}`).searchParams.get("page"));
      if (kind === "within a page") return pageReply([play("New", 190), play("Newer", 200), play("Anchor", 100)]);
      return pageReply(page === 1 ? Array.from({ length: 20 }, (_, index) => play(`New ${index}`, 200 - index))
        : [play("Out of order", 190), play("Anchor", 100)], page, 22);
    });
    await expect(collectChanges(session, checkpoint)).rejects.toMatchObject({ code: "HISTORY_CHANGED" });
  });

  it("rejects pagination drift while collecting recent plays", async () => {
    const checkpoint = await checkpointFor([play("Anchor", 100)]);
    const { session } = setup((path) => {
      if (!path.startsWith("game/chunithm/playlog?")) return;
      const page = Number(new URL(`${ORIGIN}/${path}`).searchParams.get("page"));
      return pageReply(page === 1 ? Array.from({ length: 20 }, (_, index) => play(`New ${index}`, 200 - index))
        : [play("Anchor", 100), play("Older", 90)], page, page === 1 ? 21 : 22);
    });
    await expect(collectChanges(session, checkpoint)).rejects.toMatchObject({ code: "HISTORY_CHANGED" });
  });

  it("rejects a new play shifting the head before cursor commit", async () => {
    const checkpoint = await checkpointFor([play("Anchor", 100)]);
    let reads = 0;
    const { session } = setup((path) => path.startsWith("game/chunithm/playlog?")
      ? pageReply(++reads === 1 ? [play("New", 200), play("Anchor", 100)]
        : [play("Concurrent new", 300), play("New", 200), play("Anchor", 100)]) : undefined);
    await expect(collectChanges(session, checkpoint)).rejects.toMatchObject({ code: "HISTORY_CHANGED" });
    expect(reads).toBe(2);
  });

  it("fails atomically when a later history page fails", async () => {
    const checkpoint = await checkpointFor([play("Anchor", 100)]);
    const { session } = setup((path) => {
      if (!path.startsWith("game/chunithm/playlog?")) return;
      const page = Number(new URL(`${ORIGIN}/${path}`).searchParams.get("page"));
      return page === 1 ? pageReply(Array.from({ length: 20 }, (_, index) => play(`New ${index}`, 200 - index)), 1, 21) : { status: 503 };
    });
    await expect(collectChanges(session, checkpoint)).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(checkpoint.timestamp).toBe(100);
  });

  it("uses the existing rate-limit retry and request spacing for history", async () => {
    const checkpoint = await checkpointFor([play("Anchor", 100)]);
    let reads = 0;
    const { session, gameRequests } = setup((path) => path.startsWith("game/chunithm/playlog?")
      ? ++reads === 1 ? { status: 429, headers: { "retry-after": "5" } }
        : pageReply([play("New", 200), play("Anchor", 100)]) : undefined);
    const start = Date.now();
    expect((await collectChanges(session, checkpoint)).payload).toHaveLength(1);
    expect(gameRequests.map(({ at }) => at - start)).toEqual([0, 5_000, 6_100]);
  });

  it("rejects a main-card change after reading history without exposing candidates or cursor", async () => {
    const checkpoint = await checkpointFor([play("Anchor", 100)]);
    let cardReads = 0;
    const { session } = setup((path) => {
      if (path === "aime/card") return { data: [{ id: ++cardReads === 1 ? 7 : 8, is_main: true }] };
      if (path.startsWith("game/chunithm/playlog?")) return pageReply([play("New", 200), play("Anchor", 100)]);
    });
    await expect(collectChanges(session, checkpoint)).rejects.toMatchObject({ code: "IDENTITY_CHANGED" });
  });

  it.each([
    { ...play("Bad date", 100), play_date: "100" },
    { ...play("Bad date", 100), play_date: 100.5 },
    { ...play("Bad score", 100), score: null },
    { ...play("Bad score", 100), score: 1_010_001 },
    { ...play("Bad difficulty", 100), difficulty: 6 },
    { ...play("Bad track", 100), track: "1" },
    { ...play("Bad music", 100), music: { music_id: "missing-title" } },
  ])("rejects changed or malformed history fields %#", async (record) => {
    const { session } = setup((path) => path.startsWith("game/chunithm/playlog?") ? pageReply([record]) : undefined);
    await expect(collectChanges(session)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects a truncated nonfinal history page before skipping potentially missing new plays", async () => {
    const checkpoint = await checkpointFor([play("Anchor", 100)]);
    const { session } = setup((path) => path.startsWith("game/chunithm/playlog?")
      ? pageReply([play("New", 200), play("Anchor", 100), play("Old", 90)], 1, 21) : undefined);
    await expect(collectChanges(session, checkpoint)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("cancels a history cooldown without advancing the caller's checkpoint", async () => {
    const checkpoint = await checkpointFor([play("Anchor", 100)]);
    const { session, context, gameRequests } = setup((path) => path.startsWith("game/chunithm/playlog?")
      ? { status: 429, headers: { "retry-after": "600" } } : undefined);
    const pending = otogameProvider.fetchScoreChanges!(session, identity, checkpoint).then(
      () => null, (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(gameRequests).toHaveLength(1);
    context.emit("close");
    await expect(pending).resolves.toMatchObject({ code: "SYNC_CANCELLED" });
    expect(checkpoint.timestamp).toBe(100);
    expect(vi.getTimerCount()).toBe(0);
    expect(context.listenerCount("close")).toBe(0);
  });

  it("rejects incomplete history counts when reading through the end", async () => {
    const { session } = setup((path) => path.startsWith("game/chunithm/playlog?")
      ? { data: { data: [play("Only", 100)], pagination: { page: 1, total_page: 1, total: 2 } } } : undefined);
    await expect(collectChanges(session, { timestamp: null, boundaryKeys: [] })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
