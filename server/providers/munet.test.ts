import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserSession } from "../provider";
import { munetProvider } from "./munet";

const token = (sub = "42", nonce = "old") => `header.${Buffer.from(JSON.stringify({ sub, nonce })).toString("base64url")}.signature`;
const identity = { id: "42", label: "player" };
const userHome = { user: { username: "player" }, cards: [] };
const score = { musicId: 100, level: 3, scoreMax: 1_009_000 };

function response(payload: unknown, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: vi.fn(async () => payload) };
}

function session(responses: ReturnType<typeof response>[]) {
  const storage = new Map([ ["token", token()], ["refreshToken", "private-refresh"], ["environmentKey", "test-environment"] ]);
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.stubGlobal("location", { origin: "https://portal.mumur.net" });
  const fetch = vi.fn(async (_url: string, _options?: Record<string, unknown>) => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next;
  });
  vi.stubGlobal("fetch", fetch);
  const apiFetch = vi.fn(async () => { throw new Error("MuNET must use the portal browser transport"); });
  return {
    storage, fetch, apiFetch,
    value: {
      context: { request: { fetch: apiFetch } },
      page: { url: () => "https://portal.mumur.net/user", evaluate: vi.fn(async (fn: (arg?: unknown) => unknown, arg?: unknown) => fn(arg)) },
    } as unknown as BrowserSession,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("MuNET browser provider", () => {
  it("validates the token remotely before identifying its subject", async () => {
    const mock = session([response(userHome)]);
    await expect(munetProvider.identify(mock.value)).resolves.toEqual(identity);
    expect(mock.fetch).toHaveBeenCalledWith("https://apidashboard3-cf.mumur.net/api/v3/UserHome?locale=zh-Hans", expect.objectContaining({
      headers: { Accept: "application/json", Authorization: `Bearer ${token()}`, "X-Env-Key": "test-environment" },
      redirect: "error", credentials: "same-origin", referrerPolicy: "no-referrer", signal: expect.any(AbortSignal),
    }));
    expect(mock.apiFetch).not.toHaveBeenCalled();
  });

  it("refreshes an expired token once and saves it for later browser sessions", async () => {
    const renewed = token("42", "new");
    const mock = session([response(null, 401), response(renewed), response(userHome)]);
    await expect(munetProvider.identify(mock.value)).resolves.toEqual(identity);
    expect(mock.fetch.mock.calls[1]).toEqual(["https://apidashboard3-cf.mumur.net/api/v3/TokenExchange/RefreshToken", expect.objectContaining({
      method: "POST", body: JSON.stringify({ token: "private-refresh", auId: 42 }),
      headers: expect.objectContaining({ "Content-Type": "application/json" }),
    })]);
    expect(mock.storage.get("token")).toBe(renewed);
    expect(mock.fetch).toHaveBeenCalledTimes(3);
  });

  it("requires login when the server rejects an expired refresh token with HTTP 400", async () => {
    const mock = session([response(null, 401), response(null, 400)]);
    await expect(munetProvider.identify(mock.value)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(mock.fetch).toHaveBeenCalledTimes(2);
    expect(mock.storage.get("token")).toBe(token());
  });

  it("still reports HTTP 400 on the score endpoint as an upstream failure", async () => {
    const mock = session([response(userHome), response(null, 400)]);
    await expect(munetProvider.fetchScores(mock.value, identity)).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(mock.fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects a refreshed token for another account", async () => {
    const mock = session([response(null, 401), response(token("99"))]);
    await expect(munetProvider.identify(mock.value)).rejects.toMatchObject({ code: "IDENTITY_CHANGED" });
    expect(mock.storage.get("token")).toBe(token());
  });

  it("does not retry a second unauthorized response", async () => {
    const mock = session([response(null, 401), response(token("42", "new")), response(null, 401)]);
    await expect(munetProvider.identify(mock.value)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(mock.fetch).toHaveBeenCalledTimes(3);
  });

  it("exports via v2 POST and retains only CHUNITHM score fields", async () => {
    const mock = session([response(userHome), response({ gameId: "SDHD", userData: { name: "private" }, userMusicDetailList: [{ ...score, privateField: "secret" }], userPlaylogList: [score] })]);
    await expect(munetProvider.fetchScores(mock.value, identity)).resolves.toEqual({ gameId: "SDHD", userMusicDetailList: [score] });
    const [url, options] = mock.fetch.mock.calls[1] as unknown as [string, Record<string, unknown>];
    expect(new URL(url).pathname).toBe("/api/v2/game/chu3/export");
    expect(new URL(url).searchParams.get("token")).toBe(token());
    expect(options).toMatchObject({ method: "POST", redirect: "error", body: null, headers: { "X-Env-Key": "test-environment" } });
    expect(options.headers).not.toHaveProperty("Accept");
    expect(options.headers).not.toHaveProperty("Content-Type");
    expect(mock.apiFetch).not.toHaveBeenCalled();
  });

  it("retries an expired export with the renewed token", async () => {
    const renewed = token("42", "new");
    const mock = session([response(userHome), response(null, 401), response(renewed),
      response({ gameId: "SDHD", userMusicDetailList: [score] })]);
    await expect(munetProvider.fetchScores(mock.value, identity)).resolves.toEqual({ gameId: "SDHD", userMusicDetailList: [score] });
    expect(new URL(mock.fetch.mock.calls[3][0]).searchParams.get("token")).toBe(renewed);
    expect(mock.fetch).toHaveBeenCalledTimes(4);
  });

  it("refuses a different saved identity before downloading scores", async () => {
    const mock = session([response(userHome)]);
    await expect(munetProvider.fetchScores(mock.value, { ...identity, id: "99" })).rejects.toMatchObject({ code: "IDENTITY_CHANGED" });
    expect(mock.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { user: {} }, { user: { username: "" } }])("rejects invalid identity responses", async (payload) => {
    const mock = session([response(payload)]);
    await expect(munetProvider.identify(mock.value)).rejects.toMatchObject({ code: "UPSTREAM_FORMAT" });
  });

  it.each([
    { gameId: "SDEZ", userMusicDetailList: [] },
    { gameId: null, userMusicDetailList: [] },
    {},
    { gameId: "SDHD", userMusicDetailList: null },
    { gameId: "SDHD", userMusicDetailList: [{ ...score, scoreMax: 1_010_001 }] },
  ])("rejects other games and invalid exports", async (payload) => {
    const mock = session([response(userHome), response(payload)]);
    await expect(munetProvider.fetchScores(mock.value, identity)).rejects.toMatchObject({ code: "UPSTREAM_FORMAT" });
  });

  it("accepts empty CHUNITHM score lists", async () => {
    const mock = session([response(userHome), response({ gameId: "SDHD", userMusicDetailList: [] })]);
    await expect(munetProvider.fetchScores(mock.value, identity)).resolves.toEqual({ gameId: "SDHD", userMusicDetailList: [] });
  });

  it.each([{ userMusicDetailList: [] }, { userMusicDetailList: [score] }])("accepts an omitted gameId from the CHUNITHM export endpoint", async ({ userMusicDetailList }) => {
    const mock = session([response(userHome), response({ userMusicDetailList })]);
    await expect(munetProvider.fetchScores(mock.value, identity)).resolves.toEqual({ gameId: "SDHD", userMusicDetailList });
  });

  it("rejects redirects without exposing token-bearing request URLs", async () => {
    const mock = session([response(userHome), response(null, 302)]);
    await expect(munetProvider.fetchScores(mock.value, identity)).rejects.toMatchObject({ code: "REDIRECT_REJECTED" });
    expect(mock.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not treat HTTP 418 as an authenticated or successful response", async () => {
    const mock = session([response({ private: "error details" }, 418)]);
    await expect(munetProvider.identify(mock.value)).rejects.toMatchObject({ code: "UPSTREAM_ERROR", message: "成绩服务器请求失败（HTTP 418）。" });
    expect(mock.fetch).toHaveBeenCalledTimes(1);
  });

  it("redacts native fetch failures containing credentials", async () => {
    const mock = session([response(userHome)]);
    mock.fetch.mockRejectedValueOnce(new Error(`fetch failed: token=${token()} private-refresh`));
    await expect(munetProvider.identify(mock.value)).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE", message: "无法连接 MuNET 成绩服务器，请稍后重试或重新网页登录。",
    });
  });

  it("aborts browser requests after 15 seconds", async () => {
    vi.useFakeTimers();
    const mock = session([]);
    mock.fetch.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      (options?.signal as AbortSignal).addEventListener("abort", () => reject(new Error("request aborted")));
    }));
    const assertion = expect(munetProvider.identify(mock.value)).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect((mock.fetch.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
  });

  it("rejects invalid JSON from the browser transport", async () => {
    const invalid = response(null);
    invalid.json.mockRejectedValueOnce(new Error("private upstream response"));
    const mock = session([invalid]);
    await expect(munetProvider.identify(mock.value)).rejects.toMatchObject({ code: "UPSTREAM_FORMAT" });
  });

  it("does not send credentials after navigation away from the portal", async () => {
    const mock = session([]);
    vi.stubGlobal("location", { origin: "https://example.org" });
    await expect(munetProvider.identify(mock.value)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(mock.fetch).not.toHaveBeenCalled();
  });
});
