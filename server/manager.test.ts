import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceManager } from "./manager";
import { SourceStore } from "./store";
import { SyncError, type BrowserProvider, type BrowserSession } from "./provider";
import { LxnsProvider } from "./providers/lxns";
import { CATALOG_VERSION, catalog } from "../src/core/catalog";

const folders: string[] = [];
const managers: SourceManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

const identity = { id: "account-1", label: "测试账号", cardId: "card-1" };
const chart = catalog[0];
const payload = { userMusicDetailList: [{ musicId: chart.id, level: chart.difficulty, scoreMax: 1_005_000 }] };

function browserSession(url = "https://portal.example/login") {
  const makePage = (initialUrl: string) => {
    const state = { url: initialUrl, closed: false };
    return { state, url: () => state.url, isClosed: () => state.closed };
  };
  const original = makePage(url);
  const pages = [original];
  const close = vi.fn(async () => { for (const page of pages) page.state.closed = true; });
  return {
    original, pages, close,
    addPage: (url: string) => {
      const page = makePage(url);
      pages.push(page);
      return page;
    },
    session: { page: original, context: { pages: () => pages.filter((page) => !page.isClosed()), close } } as unknown as BrowserSession,
  };
}

async function setup(remoteLogin = false) {
  const directory = await mkdtemp(join(tmpdir(), "machun-manager-"));
  folders.push(directory);
  const provider: BrowserProvider = {
    source: "rin", loginUrl: "https://portal.example/login",
    identify: vi.fn().mockResolvedValue(identity), fetchScores: vi.fn().mockResolvedValue(payload),
  };
  const launcher = {
    open: vi.fn(async () => browserSession().session),
  };
  const options = { store: new SourceStore(directory), providers: { rin: provider, munet: provider, otogame: provider }, launcher, bindPollMs: 2, bindTimeoutMs: 2000, remoteLogin };
  const manager = new SourceManager(options);
  managers.push(manager);
  await manager.initialize();
  return { manager, provider, launcher, options, directory };
}

async function bound(manager: SourceManager, source: "rin" | "otogame" = "rin") {
  await manager.bind(source);
  await vi.waitFor(() => expect(manager.connections().find((item) => item.source === source)?.status).toBe("ready"));
}

describe("local source manager", () => {
  it("offers a remote window only during binding and permits one visible window", async () => {
    const { manager, provider } = await setup(true);
    vi.mocked(provider.identify).mockRejectedValue(new SyncError("AUTH_REQUIRED", "等待登录", 401));
    const pending = await manager.bind("rin");
    expect(pending.loginUrl).toMatch(/^\/login-view\/vnc\.html\?/);
    await expect(manager.bind("munet")).rejects.toMatchObject({ code: "BUSY" });
    vi.mocked(provider.identify).mockResolvedValue(identity);
    await vi.waitFor(() => expect(manager.connections().find((item) => item.source === "rin")?.status).toBe("ready"));
    expect(manager.connections().find((item) => item.source === "rin")).not.toHaveProperty("loginUrl");
    vi.mocked(provider.identify).mockRejectedValue(new SyncError("AUTH_REQUIRED", "等待登录", 401));
    expect((await manager.bind("munet")).loginUrl).toBeTruthy();
    expect(await manager.unbind("munet")).not.toHaveProperty("loginUrl");
  });
  it("does not expose a remote login URL for native browser windows", async () => {
    const { manager, provider } = await setup();
    vi.mocked(provider.identify).mockRejectedValue(new SyncError("AUTH_REQUIRED", "等待登录", 401));
    expect(await manager.bind("rin")).not.toHaveProperty("loginUrl");
  });
  it("starts without upstream calls and restores a saved profile after restart", async () => {
    const { manager, provider, options, launcher, directory } = await setup();
    expect(provider.identify).not.toHaveBeenCalled();
    expect(launcher.open).not.toHaveBeenCalled();
    await bound(manager);
    const saved = JSON.parse(await readFile(join(directory, "rin.json"), "utf8"));
    const replacement = new SourceManager(options);
    managers.push(replacement);
    await replacement.initialize();
    expect(replacement.connections().find((item) => item.source === "rin")).toMatchObject({ bound: true, identity });
    const result = await replacement.sync("rin");
    expect(result.records).toHaveLength(1);
    expect(launcher.open).toHaveBeenLastCalledWith(options.store.profilePath(saved.binding.profile), provider.loginUrl, false);
    expect((await stat(join(directory, "rin.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  it("returns only normalized scores and metadata, never the original payload", async () => {
    const { manager, provider } = await setup();
    vi.mocked(provider.fetchScores).mockResolvedValue({ ...payload, credentials: { token: "private-token", accountName: "hidden account" } });
    await bound(manager);
    const result = await manager.sync("rin");
    expect(result.records[0]).toMatchObject({ id: chart.id, difficulty: chart.difficulty, score: 1_005_000, source: "rin" });
    expect(JSON.stringify(result)).not.toMatch(/private-token|hidden account|profile|credentials/);
    expect(result.connection.lastSuccessAt).toBeTruthy();
  });

  it("rejects duplicate clicks and preserves the last successful time on a failed sync", async () => {
    const { manager, provider } = await setup();
    await bound(manager);
    const success = await manager.sync("rin");
    let rejectFetch!: (reason: unknown) => void;
    vi.mocked(provider.fetchScores).mockReturnValue(new Promise((_, reject) => { rejectFetch = reject; }));
    const pending = manager.sync("rin");
    const rejection = expect(pending).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    await vi.waitFor(() => expect(provider.fetchScores).toHaveBeenCalledTimes(2));
    await expect(manager.sync("rin")).rejects.toMatchObject({ code: "BUSY" });
    rejectFetch(new SyncError("AUTH_REQUIRED", "请重新登录。", 401));
    await rejection;
    expect(manager.connections().find((item) => item.source === "rin")).toMatchObject({ status: "auth_required", lastSuccessAt: success.connection.lastSuccessAt, bound: true });
  });

  it("exposes current sync progress in connection snapshots and clears it after success", async () => {
    const { manager, provider, options } = await setup();
    await bound(manager);
    let release!: (value: unknown) => void;
    vi.mocked(provider.fetchScores).mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const pending = manager.sync("rin");
    expect(manager.connections().find((item) => item.source === "rin")).not.toHaveProperty("progress");
    await vi.waitFor(() => expect(provider.fetchScores).toHaveBeenCalledOnce());
    const report = vi.mocked(provider.fetchScores).mock.calls[0][2]!;
    const progress = { completedPages: 3, retryAt: "2026-10-04T15:00:00.000Z" };
    report(progress);
    expect(manager.connections().find((item) => item.source === "rin")).toMatchObject({ status: "syncing", progress });
    expect(manager.connections().find((item) => item.source === "munet")).not.toHaveProperty("progress");
    progress.completedPages = 99;
    const snapshot = manager.connections().find((item) => item.source === "rin")!;
    expect(snapshot.progress?.completedPages).toBe(3);
    snapshot.progress!.completedPages = 88;
    expect(manager.connections().find((item) => item.source === "rin")?.progress?.completedPages).toBe(3);
    expect(await options.store.load("rin")).not.toHaveProperty("progress");
    release(payload);
    const result = await pending;
    expect(result.connection).not.toHaveProperty("progress");
    expect(manager.connections().find((item) => item.source === "rin")).not.toHaveProperty("progress");
    report({ completedPages: 4, retryAt: null });
    expect(manager.connections().find((item) => item.source === "rin")).not.toHaveProperty("progress");
  });

  it("clears sync progress after failure and ignores subsequent callbacks", async () => {
    const { manager, provider } = await setup();
    await bound(manager);
    let reject!: (error: unknown) => void;
    vi.mocked(provider.fetchScores).mockReturnValueOnce(new Promise((_, rejectFetch) => { reject = rejectFetch; }));
    const pending = manager.sync("rin");
    const rejection = expect(pending).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await vi.waitFor(() => expect(provider.fetchScores).toHaveBeenCalledOnce());
    const report = vi.mocked(provider.fetchScores).mock.calls[0][2]!;
    report({ completedPages: 2, retryAt: "2026-10-04T15:00:00.000Z" });
    expect(manager.connections().find((item) => item.source === "rin")?.progress?.completedPages).toBe(2);
    reject(new SyncError("RATE_LIMITED", "请稍后重试。", 429));
    await rejection;
    const result = manager.connections().find((item) => item.source === "rin")!;
    expect(result.status).toBe("error");
    expect(result).not.toHaveProperty("progress");
    report({ completedPages: 3, retryAt: null });
    expect(manager.connections().find((item) => item.source === "rin")).not.toHaveProperty("progress");
  });

  it("ignores an old sync callback while a later sync is running", async () => {
    const { manager, provider } = await setup();
    await bound(manager);
    await manager.sync("rin");
    const staleReport = vi.mocked(provider.fetchScores).mock.calls[0][2]!;
    let release!: (value: unknown) => void;
    vi.mocked(provider.fetchScores).mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const pending = manager.sync("rin");
    await vi.waitFor(() => expect(provider.fetchScores).toHaveBeenCalledTimes(2));
    staleReport({ completedPages: 99, retryAt: null });
    expect(manager.connections().find((item) => item.source === "rin")).not.toHaveProperty("progress");
    const currentReport = vi.mocked(provider.fetchScores).mock.calls[1][2]!;
    currentReport({ completedPages: 1, retryAt: null });
    staleReport({ completedPages: 99, retryAt: "2026-10-04T15:00:00.000Z" });
    expect(manager.connections().find((item) => item.source === "rin")?.progress).toEqual({ completedPages: 1, retryAt: null });
    release(payload);
    await pending;
  });

  it("cancels an interactive login and removes its unfinished profile", async () => {
    const { manager, provider, directory } = await setup();
    vi.mocked(provider.identify).mockRejectedValue(new SyncError("AUTH_REQUIRED", "等待登录", 401));
    expect((await manager.bind("rin")).status).toBe("binding");
    await vi.waitFor(() => expect(provider.identify).toHaveBeenCalled());
    const unbound = await manager.unbind("rin");
    expect(unbound).toMatchObject({ status: "unbound", bound: false, identity: null });
    const saved = JSON.parse(await readFile(join(directory, "rin.json"), "utf8"));
    expect(saved.binding).toBeNull();
    await expect(manager.sync("rin")).rejects.toMatchObject({ code: "NOT_BOUND" });
  });

  it("uses the newest open portal page and ignores lookalike origins and closed pages", async () => {
    const { manager, provider, launcher } = await setup();
    const browser = browserSession();
    const callback = browser.addPage("https://portal.example/oauth/callback");
    browser.addPage("https://portal.example.attacker.invalid/oauth/callback");
    browser.addPage("http://portal.example/oauth/callback");
    browser.addPage("https://portal.example:8443/oauth/callback");
    browser.addPage("https://portal.example/closed").state.closed = true;
    launcher.open.mockResolvedValueOnce(browser.session);
    vi.mocked(provider.identify).mockImplementation(async (session) => {
      expect(session.page).toBe(callback);
      return identity;
    });
    await bound(manager);
    expect(provider.identify).toHaveBeenCalledOnce();
  });

  it("waits for an OAuth popup to return even when the original page has closed", async () => {
    const { manager, provider, launcher } = await setup();
    const browser = browserSession();
    browser.original.state.closed = true;
    const popup = browser.addPage("https://bemanicn.com/login");
    launcher.open.mockResolvedValueOnce(browser.session);
    await manager.bind("rin");
    await vi.waitFor(() => expect(launcher.open).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(manager.connections().find((item) => item.source === "rin")?.status).toBe("binding");
    expect(provider.identify).not.toHaveBeenCalled();
    popup.state.url = "https://portal.example/oauth/callback";
    await vi.waitFor(() => expect(manager.connections().find((item) => item.source === "rin")?.status).toBe("ready"));
    expect(vi.mocked(provider.identify).mock.calls[0][0].page).toBe(popup);
  });

  it("cancels binding when all pages have closed", async () => {
    const { manager, provider, launcher } = await setup();
    const browser = browserSession();
    launcher.open.mockResolvedValueOnce(browser.session);
    vi.mocked(provider.identify).mockRejectedValue(new SyncError("AUTH_REQUIRED", "等待登录", 401));
    await manager.bind("rin");
    await vi.waitFor(() => expect(provider.identify).toHaveBeenCalled());
    browser.original.state.closed = true;
    await vi.waitFor(() => expect(manager.connections().find((item) => item.source === "rin")).toMatchObject({
      status: "error", bound: false, error: "登录窗口已关闭或等待超时，请重新登录。",
    }));
    expect(browser.close).toHaveBeenCalled();
  });

  it.each(["UPSTREAM_UNAVAILABLE", "NETWORK_ERROR"])("recovers after three consecutive %s failures", async (code) => {
    const { manager, provider } = await setup();
    vi.mocked(provider.identify)
      .mockRejectedValueOnce(new SyncError(code, "暂态错误"))
      .mockRejectedValueOnce(new SyncError(code, "暂态错误"))
      .mockRejectedValueOnce(new SyncError(code, "暂态错误"));
    await bound(manager);
    expect(provider.identify).toHaveBeenCalledTimes(4);
  });

  it.each(["UPSTREAM_UNAVAILABLE", "NETWORK_ERROR"])("stops after a fourth consecutive %s failure", async (code) => {
    const { manager, provider } = await setup();
    vi.mocked(provider.identify).mockRejectedValue(new SyncError(code, "连续暂态错误"));
    await manager.bind("rin");
    await vi.waitFor(() => expect(manager.connections().find((item) => item.source === "rin")).toMatchObject({
      status: "error", bound: false, error: "连续暂态错误",
    }));
    expect(provider.identify).toHaveBeenCalledTimes(4);
  });

  it("resets the transient failure count while waiting for authentication", async () => {
    const { manager, provider } = await setup();
    const identify = vi.mocked(provider.identify);
    for (let index = 0; index < 3; index++) identify.mockRejectedValueOnce(new SyncError("UPSTREAM_UNAVAILABLE", "暂态错误"));
    identify.mockRejectedValueOnce(new SyncError("AUTH_REQUIRED", "等待登录", 401));
    for (let index = 0; index < 3; index++) identify.mockRejectedValueOnce(new SyncError("NETWORK_ERROR", "暂态错误"));
    await bound(manager);
    expect(provider.identify).toHaveBeenCalledTimes(8);
  });

  it.each(["UPSTREAM_FORMAT", "IDENTITY_CHANGED", "CARD_REQUIRED"])("does not retry terminal binding error %s", async (code) => {
    const { manager, provider } = await setup();
    vi.mocked(provider.identify).mockRejectedValue(new SyncError(code, "终止绑定"));
    await manager.bind("rin");
    await vi.waitFor(() => expect(manager.connections().find((item) => item.source === "rin")?.error).toBe("终止绑定"));
    expect(provider.identify).toHaveBeenCalledOnce();
  });

  it("keeps the existing binding if a replacement login fails", async () => {
    const { manager, provider, options } = await setup();
    await bound(manager);
    const before = await options.store.load("rin");
    vi.mocked(provider.identify).mockRejectedValue(new SyncError("INVALID_RESPONSE", "门户结构变化"));
    await manager.bind("rin");
    await vi.waitFor(() => expect(manager.connections().find((item) => item.source === "rin")?.status).toBe("error"));
    expect((await options.store.load("rin")).binding).toEqual(before.binding);
    expect(manager.connections().find((item) => item.source === "rin")?.bound).toBe(true);
  });

  it("unbinds persisted credentials and deletes the old browser profile", async () => {
    const { manager, options } = await setup();
    await bound(manager);
    const saved = await options.store.load("rin");
    await manager.unbind("rin");
    expect((await options.store.load("rin")).binding).toBeNull();
    await expect(stat(options.store.profilePath(saved.binding!.profile!))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits for a browser still launching during shutdown and closes it without fetching scores", async () => {
    const { manager, launcher, provider } = await setup();
    await bound(manager);
    let release!: (session: BrowserSession) => void;
    launcher.open.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const syncing = manager.sync("rin");
    const rejected = expect(syncing).rejects.toMatchObject({ code: "SHUTTING_DOWN" });
    await vi.waitFor(() => expect(launcher.open).toHaveBeenCalledTimes(2));
    let closed = false;
    const shutdown = manager.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    const close = vi.fn().mockResolvedValue(undefined);
    release({ context: { close }, page: {} } as unknown as BrowserSession);
    await rejected;
    await shutdown;
    expect(close).toHaveBeenCalled();
    expect(provider.fetchScores).not.toHaveBeenCalled();
  });

  it("prevents a new bind or sync while unbinding is persisting", async () => {
    const { manager, options } = await setup();
    await bound(manager);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const original = options.store.save.bind(options.store);
    const saving = vi.spyOn(options.store, "save").mockImplementation(async (source, value) => {
      await blocked;
      return original(source, value);
    });
    const removing = manager.unbind("rin");
    await vi.waitFor(() => expect(saving).toHaveBeenCalled());
    await expect(manager.sync("rin")).rejects.toMatchObject({ code: "BUSY" });
    await expect(manager.bind("rin")).rejects.toMatchObject({ code: "BUSY" });
    release();
    expect(await removing).toMatchObject({ status: "unbound", bound: false });
  });

  it("persists a validated LXNS token but excludes it from all public responses", async () => {
    const { options } = await setup();
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: { friend_code: 12345, name: "玩家" } })));
    const manager = new SourceManager({ ...options, lxns: new LxnsProvider(fetcher) });
    managers.push(manager);
    await manager.initialize();
    const result = await manager.bind("lxns", " fake-secret ");
    expect(result).toMatchObject({ status: "ready", bound: true, identity: { id: "12345", label: "玩家" } });
    expect((await options.store.load("lxns")).binding?.token).toBe("fake-secret");
    expect(JSON.stringify(manager.connections())).not.toContain("fake-secret");
    await manager.unbind("lxns");
    expect(JSON.stringify(await options.store.load("lxns"))).not.toContain("fake-secret");
  });
});

describe("persisted Otogame incremental baseline", () => {
  const checkpoint = { timestamp: 100, boundaryKeys: ["a".repeat(64)] };
  const newer = { timestamp: 200, boundaryKeys: ["b".repeat(64)] };

  async function incrementalSetup() {
    const fixture = await setup();
    fixture.provider.fetchScoreChanges = vi.fn().mockResolvedValue({ payload, checkpoint });
    await bound(fixture.manager, "otogame");
    return fixture;
  }

  it("initializes once, restores its checkpoint after restart and returns the whole cache on an empty delta", async () => {
    const { manager, provider, options, directory } = await incrementalSetup();
    const first = await manager.sync("otogame");
    const changes = vi.mocked(provider.fetchScoreChanges!);
    expect(changes.mock.calls[0][2]).toBeUndefined();
    expect(provider.fetchScores).not.toHaveBeenCalled();
    const saved = await options.store.load("otogame");
    expect(saved.otogameCache).toMatchObject({ identity, checkpoint, records: [{ score: 1_005_000, source: "otogame" }] });
    expect((await stat(join(directory, "otogame.json"))).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(manager.connections())).not.toContain("boundaryKeys");
    expect(first).not.toHaveProperty("checkpoint");
    // A caller changing a response must not corrupt the in-memory baseline.
    first.records[0].score = 1;
    const replacement = new SourceManager(options);
    managers.push(replacement);
    await replacement.initialize();
    changes.mockResolvedValueOnce({ payload: [], checkpoint });
    const repeated = await replacement.sync("otogame");
    expect(changes.mock.calls[1][2]).toEqual(checkpoint);
    expect(repeated.records[0].score).toBe(1_005_000);
    // Returning all scores also recovers a previous response lost before browser merging.
    expect(repeated.records).toEqual(saved.otogameCache?.records);
  });

  it("keeps the highest cached score while importing changed charts and advances the checkpoint together", async () => {
    const { manager, provider, options } = await incrementalSetup();
    await manager.sync("otogame");
    const secondChart = catalog[1];
    vi.mocked(provider.fetchScoreChanges!).mockResolvedValueOnce({
      payload: [
        { musicId: chart.id, level: chart.difficulty, score: 990_000 },
        { musicId: secondChart.id, level: secondChart.difficulty, score: 1_001_000 },
      ], checkpoint: newer,
    });
    const next = await manager.sync("otogame");
    expect(next.records).toHaveLength(2);
    expect(next.records.find((record) => record.id === chart.id)?.score).toBe(1_005_000);
    const saved = await options.store.load("otogame");
    expect(saved.otogameCache?.checkpoint).toEqual(newer);
    expect(saved.otogameCache?.records).toEqual(next.records);
  });

  it.each(["legacy", "older-catalog", "older-strategy"])("replays all history for %s metadata and retains existing maximums", async (kind) => {
    const { manager, provider, options } = await incrementalSetup();
    await manager.sync("otogame");
    const saved = await options.store.load("otogame");
    if (kind === "legacy") {
      delete saved.otogameCache!.catalogVersion;
      delete saved.otogameCache!.strategy;
    } else if (kind === "older-catalog") {
      saved.otogameCache!.catalogVersion = "Mate-2026-09-17-14plus";
    } else {
      delete saved.otogameCache!.strategy;
    }
    await options.store.save("otogame", saved);
    const replacement = new SourceManager(options);
    managers.push(replacement);
    await replacement.initialize();
    const changes = vi.mocked(provider.fetchScoreChanges!);
    const newlyEligible = catalog.find((candidate) => candidate.constant === 13)!;
    changes.mockResolvedValueOnce({ payload: [
      { musicId: chart.id, level: chart.difficulty, score: 990_000 },
      { musicId: newlyEligible.id, level: newlyEligible.difficulty, score: 1_004_000 },
    ], checkpoint: newer });
    const next = await replacement.sync("otogame");
    expect(changes.mock.calls.at(-1)?.[2]).toBeUndefined();
    expect(next.records).toHaveLength(2);
    expect(next.records.find((record) => record.id === chart.id && record.difficulty === chart.difficulty)?.score).toBe(1_005_000);
    expect(next.records.find((record) => record.id === newlyEligible.id && record.difficulty === newlyEligible.difficulty))
      .toMatchObject({ score: 1_004_000, constant: 13, source: "otogame" });
    expect((await options.store.load("otogame")).otogameCache).toMatchObject({
      catalogVersion: CATALOG_VERSION, strategy: "playlog", checkpoint: newer,
    });
    changes.mockResolvedValueOnce({ payload: [], checkpoint: newer });
    await replacement.sync("otogame");
    expect(changes.mock.calls.at(-1)?.[2]).toEqual(newer);
  });

  it("retains previous scores when a full-history calibration has no remaining playlog entries", async () => {
    const { manager, provider, options } = await incrementalSetup();
    await manager.sync("otogame");
    vi.mocked(provider.fetchScoreChanges!).mockResolvedValueOnce({ payload: [], checkpoint: { timestamp: null, boundaryKeys: [] } });
    const result = await manager.sync("otogame", { full: true });
    expect(vi.mocked(provider.fetchScoreChanges!).mock.calls.at(-1)?.[2]).toBeUndefined();
    expect(result.records[0].score).toBe(1_005_000);
    expect((await options.store.load("otogame")).otogameCache?.records).toEqual(result.records);
  });

  it("does not advance a checkpoint after an upstream error or a malformed score", async () => {
    const { manager, provider, options } = await incrementalSetup();
    await manager.sync("otogame");
    const changes = vi.mocked(provider.fetchScoreChanges!);
    changes.mockRejectedValueOnce(new SyncError("UPSTREAM_ERROR", "failed"));
    await expect(manager.sync("otogame")).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    changes.mockResolvedValueOnce({ payload: [{ musicId: chart.id, level: chart.difficulty, score: "bad-score" }], checkpoint: newer });
    await expect(manager.sync("otogame")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    const saved = await options.store.load("otogame");
    expect(saved.otogameCache?.checkpoint).toEqual(checkpoint);
    expect(saved.otogameCache?.records[0].score).toBe(1_005_000);
    expect(changes.mock.calls.slice(1).every((call) => JSON.stringify(call[2]) === JSON.stringify(checkpoint))).toBe(true);
  });

  it("retries from the previous checkpoint when atomic persistence fails", async () => {
    const { manager, provider, options } = await incrementalSetup();
    await manager.sync("otogame");
    const changes = vi.mocked(provider.fetchScoreChanges!);
    changes.mockResolvedValueOnce({ payload: [{ musicId: chart.id, level: chart.difficulty, score: 1_009_000 }], checkpoint: newer });
    const originalSave = options.store.save.bind(options.store);
    const save = vi.spyOn(options.store, "save").mockImplementation(async (source, value) => {
      if (value.otogameCache?.checkpoint.timestamp === newer.timestamp) throw new Error("synthetic write failure");
      return originalSave(source, value);
    });
    await expect(manager.sync("otogame")).rejects.toMatchObject({ code: "SERVICE_ERROR" });
    expect((await options.store.load("otogame")).otogameCache?.checkpoint).toEqual(checkpoint);
    save.mockRestore();
    changes.mockResolvedValueOnce({ payload: [], checkpoint });
    const next = await manager.sync("otogame");
    expect(changes.mock.calls.at(-1)?.[2]).toEqual(checkpoint);
    expect(next.records[0].score).toBe(1_005_000);
  });

  it("preserves a baseline on same-card re-login, resets it for a different card or unbinding, and permits explicit full calibration", async () => {
    const { manager, provider, options } = await incrementalSetup();
    await manager.sync("otogame");
    await bound(manager, "otogame");
    expect((await options.store.load("otogame")).otogameCache?.checkpoint).toEqual(checkpoint);
    await manager.sync("otogame", { full: true });
    expect(vi.mocked(provider.fetchScoreChanges!).mock.calls.at(-1)?.[2]).toBeUndefined();
    vi.mocked(provider.identify).mockResolvedValueOnce({ ...identity, cardId: "different-card" });
    await bound(manager, "otogame");
    expect((await options.store.load("otogame")).otogameCache).toBeUndefined();
    await manager.unbind("otogame");
    expect((await options.store.load("otogame")).otogameCache).toBeUndefined();
    await expect(manager.sync("rin", { full: true })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});
