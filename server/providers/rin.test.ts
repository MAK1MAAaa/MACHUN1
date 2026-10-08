import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserSession } from "../provider";
import { rinProvider } from "./rin";

const account = { accessToken: "private-access", refreshToken: "private-refresh", tokenType: "Bearer" };
const identity = { id: "42", label: "player · 卡尾号 5678", cardId: "12345678" };
const me = (cards: unknown = [{ extId: 12345678, default: true }], id = 42) => ({ status: { code: 92001 }, data: { id, username: "player", cards } });
const score = { musicId: 100, level: 3, scoreMax: 1_009_000 };

function response(payload: unknown, status = 200) {
  return { status: () => status, ok: () => status >= 200 && status < 300, json: vi.fn(async () => payload), dispose: vi.fn(async () => {}) };
}

function session(responses: ReturnType<typeof response>[]) {
  const storage = new Map([ ["currentAccount", JSON.stringify(account)] ]);
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  const fetch = vi.fn(async (_url: string, _options?: Record<string, unknown>) => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next;
  });
  return {
    storage, fetch,
    value: {
      context: { request: { fetch } },
      page: { url: () => "https://portal.naominet.live/", evaluate: vi.fn(async (fn: (arg?: unknown) => unknown, arg?: unknown) => fn(arg)) },
    } as unknown as BrowserSession,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Rin browser provider", () => {
  it("verifies the remote account and chooses its default card", async () => {
    const mock = session([response(me())]);
    await expect(rinProvider.identify(mock.value)).resolves.toEqual(identity);
    expect(mock.fetch).toHaveBeenCalledWith("https://portal.naominet.live/api/user/me", expect.objectContaining({
      headers: { Accept: "application/json", Authorization: "Bearer private-access" }, timeout: 15_000, maxRedirects: 0,
    }));
  });

  it("refreshes expired authentication once and persists the new token", async () => {
    const mock = session([response(null, 401), response({ status: { code: 92001 }, data: { accessToken: "renewed" } }), response(me())]);
    await expect(rinProvider.identify(mock.value)).resolves.toEqual(identity);
    expect(mock.fetch).toHaveBeenCalledTimes(3);
    expect(mock.fetch.mock.calls[1]).toEqual(["https://portal.naominet.live/api/auth/refresh", expect.objectContaining({ method: "POST", data: { refreshToken: account.refreshToken } })]);
    expect(JSON.parse(mock.storage.get("currentAccount")!).accessToken).toBe("renewed");
  });

  it("uses a portal renewal that completes during the first unauthorized request", async () => {
    const mock = session([response(null, 401), response(me())]);
    const fetch = mock.fetch.getMockImplementation()!;
    mock.fetch.mockImplementationOnce(async (...args) => {
      mock.storage.set("currentAccount", JSON.stringify({ ...account, accessToken: "portal-renewed" }));
      return fetch(...args);
    });
    await expect(rinProvider.identify(mock.value)).resolves.toEqual(identity);
    expect(mock.fetch).toHaveBeenCalledTimes(2);
    expect(mock.fetch.mock.calls[1]?.[1]).toMatchObject({ headers: { Authorization: "Bearer portal-renewed" } });
    expect(mock.fetch.mock.calls.some(([url]) => url.endsWith("/auth/refresh"))).toBe(false);
  });

  it("keeps a newer portal token when the same session renews concurrently", async () => {
    const mock = session([response(null, 401), response({ status: { code: 92001 }, data: { accessToken: "renewed" } }), response(me())]);
    const fetch = mock.fetch.getMockImplementation()!;
    mock.fetch.mockImplementation(async (...args) => {
      if (args[0].endsWith("/auth/refresh")) mock.storage.set("currentAccount", JSON.stringify({ ...account, accessToken: "portal-renewed" }));
      return fetch(...args);
    });
    await expect(rinProvider.identify(mock.value)).resolves.toEqual(identity);
    expect(JSON.parse(mock.storage.get("currentAccount")!).accessToken).toBe("portal-renewed");
    expect(mock.fetch.mock.calls[2]?.[1]).toMatchObject({ headers: { Authorization: "Bearer portal-renewed" } });
  });

  it("still rejects a different session appearing during renewal", async () => {
    const mock = session([response(null, 401), response({ status: { code: 92001 }, data: { accessToken: "renewed" } })]);
    const fetch = mock.fetch.getMockImplementation()!;
    mock.fetch.mockImplementation(async (...args) => {
      if (args[0].endsWith("/auth/refresh")) mock.storage.set("currentAccount", JSON.stringify({ ...account, accessToken: "other-access", refreshToken: "other-refresh" }));
      return fetch(...args);
    });
    await expect(rinProvider.identify(mock.value)).rejects.toMatchObject({ code: "IDENTITY_CHANGED" });
    expect(mock.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mock.storage.get("currentAccount")!).accessToken).toBe("other-access");
  });

  it("stops after one refresh when authentication is still rejected", async () => {
    const mock = session([response(null, 401), response({ status: { code: 92001 }, data: { accessToken: "renewed" } }), response(null, 401)]);
    await expect(rinProvider.identify(mock.value)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(mock.fetch).toHaveBeenCalledTimes(3);
  });

  it("keeps the bound card when the website default card changes and strips private data", async () => {
    const mock = session([response(me([{ extId: 12345678, default: false }, { extId: 87654321, default: true }])),
      response({ userData: { userName: "private" }, userMusicDetailList: [{ ...score, privateField: "secret" }], userPlaylogList: [score] })]);
    await expect(rinProvider.fetchScores(mock.value, identity)).resolves.toEqual({ userMusicDetailList: [score] });
    expect(mock.fetch.mock.calls[1]?.[0]).toBe("https://portal.naominet.live/api/game/chuni/v2/export?aimeId=12345678");
  });

  it("rechecks remote identity when the export needs a refreshed token", async () => {
    const mock = session([response(me()), response(null, 401),
      response({ status: { code: 92001 }, data: { accessToken: "renewed" } }),
      response({ userMusicDetailList: [score] }), response(me())]);
    await expect(rinProvider.fetchScores(mock.value, identity)).resolves.toEqual({ userMusicDetailList: [score] });
    expect(mock.fetch).toHaveBeenCalledTimes(5);
    expect(mock.fetch.mock.calls[3]?.[1]).toMatchObject({ headers: { Authorization: "Bearer renewed" } });
  });

  it("does not accept scores if a refresh changes the remote account", async () => {
    const mock = session([response(me()), response(null, 401),
      response({ status: { code: 92001 }, data: { accessToken: "renewed" } }),
      response({ userMusicDetailList: [score] }), response(me(undefined, 99))]);
    await expect(rinProvider.fetchScores(mock.value, identity)).rejects.toMatchObject({ code: "IDENTITY_CHANGED" });
  });

  it.each([
    [me([], 42), "IDENTITY_CHANGED"],
    [me(undefined, 99), "IDENTITY_CHANGED"],
    [me([{}]), "UPSTREAM_FORMAT"],
  ])("rejects missing cards, different accounts, and malformed card lists", async (payload, code) => {
    const mock = session([response(payload)]);
    await expect(rinProvider.fetchScores(mock.value, identity)).rejects.toMatchObject({ code });
    expect(mock.fetch).toHaveBeenCalledTimes(1);
  });

  it("requires one default card when binding", async () => {
    const mock = session([response(me([{ extId: 12345678, default: false }]))]);
    await expect(rinProvider.identify(mock.value)).rejects.toMatchObject({ code: "CARD_REQUIRED" });
  });

  it.each([{}, { userMusicDetailList: null }, { userMusicDetailList: [{ ...score, scoreMax: -1 }] }])("rejects malformed exports", async (payload) => {
    const mock = session([response(me()), response(payload)]);
    await expect(rinProvider.fetchScores(mock.value, identity)).rejects.toMatchObject({ code: "UPSTREAM_FORMAT" });
  });

  it("accepts an empty score list", async () => {
    const mock = session([response(me()), response({ userMusicDetailList: [] })]);
    await expect(rinProvider.fetchScores(mock.value, identity)).resolves.toEqual({ userMusicDetailList: [] });
  });

  it("rejects redirects and never includes transport details in errors", async () => {
    const mock = session([response(null, 302)]);
    await expect(rinProvider.identify(mock.value)).rejects.toMatchObject({ code: "REDIRECT_REJECTED" });
    mock.fetch.mockRejectedValueOnce(new Error(`request failed Authorization: ${account.accessToken}`));
    await expect(rinProvider.identify(mock.value)).rejects.toThrow("无法连接成绩服务器");
  });
});
