import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLocalDatabase } from "./db/sqlite";
import { SqliteSourceStore } from "./db/sqliteSourceStore";
import { SourceManager } from "./manager";
import { SyncError, type BrowserSession } from "./provider";
import { otogameProvider } from "./providers/otogame";
import { rinProvider } from "./providers/rin";
import { munetProvider } from "./providers/munet";
import type { PortableSession } from "../src/sourceBindingTypes";

const folders: string[] = [];
const managers: SourceManager[] = [];
const databases: ReturnType<typeof openLocalDatabase>[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  for (const database of databases.splice(0)) if (database.db.isOpen) database.close();
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function openStore(path: string) {
  const database = openLocalDatabase(path);
  databases.push(database);
  return { store: new SqliteSourceStore(database.db, path), close: database.close };
}

const providers = { otogame: otogameProvider, rin: rinProvider, munet: munetProvider };
const cases: {
  source: PortableSession["source"];
  initialStorage: PortableSession["localStorage"];
  renewedStorage: PortableSession["localStorage"];
}[] = [
  {
    source: "otogame",
    initialStorage: { TOKEN: '{"value":"test-access"}', ID_TOKEN: '{"value":"test-id"}', REFRESH_TOKEN: '{"value":"test-refresh"}' },
    renewedStorage: { TOKEN: '{"value":"test-new-access"}', ID_TOKEN: '{"value":"test-new-id"}', REFRESH_TOKEN: '{"value":"test-new-refresh"}' },
  },
  {
    source: "rin",
    initialStorage: { currentAccount: '{"accessToken":"test-access","tokenType":"Bearer","refreshToken":"test-refresh"}' },
    renewedStorage: { currentAccount: '{"accessToken":"test-new-access","tokenType":"Bearer","refreshToken":"test-refresh"}' },
  },
  {
    source: "munet",
    initialStorage: { token: "test-access", refreshToken: "test-refresh", environmentKey: "test-environment" },
    renewedStorage: { token: "test-new-access", refreshToken: "test-refresh", environmentKey: "test-environment" },
  },
];

function mockBrowser(url: string, localStorage: PortableSession["localStorage"]) {
  const page = { url: () => url, isClosed: () => false };
  const close = vi.fn(async () => undefined);
  const origin = new URL(url).origin;
  const storageState = vi.fn(async () => ({
    cookies: [{ name: "unused-cookie", value: "private-cookie" }],
    origins: [{
      origin,
      localStorage: Object.entries({ ...localStorage, unrelated: "private-value" }).map(([name, value]) => ({ name, value })),
    }],
  }));
  const session = { context: { pages: () => [page], close, storageState }, page } as unknown as BrowserSession;
  return { session, close };
}

describe("local source browser sessions", () => {
  it.each(cases)("captures and restores the $source session after login and restart", async ({ source, initialStorage, renewedStorage }) => {
    const path = await mkdtemp(join(tmpdir(), "machun-portable-test-"));
    folders.push(path);
    const { store, close } = openStore(path);
    const original = providers[source];
    const identity = { id: "test-account", label: "测试账户", ...(source !== "munet" ? { cardId: "test-card" } : {}) };
    const provider = {
      ...original,
      identify: vi.fn().mockRejectedValueOnce(new SyncError("AUTH_REQUIRED", "等待登录", 401)).mockResolvedValue(identity),
      fetchScores: vi.fn().mockResolvedValue({ userMusicDetailList: [] }),
      fetchScoreChanges: undefined,
    };
    const login = mockBrowser(provider.loginUrl, initialStorage);
    const headless = mockBrowser(provider.loginUrl, renewedStorage);
    const launcher = { open: vi.fn().mockResolvedValue(login.session), openPortable: vi.fn().mockResolvedValue(headless.session) };
    const options = { store, providers: { ...providers, [source]: provider }, launcher, bindPollMs: 2 };
    const manager = new SourceManager(options);
    managers.push(manager);
    await manager.initialize();

    expect(await manager.bind(source)).toMatchObject({ status: "binding", bound: false });
    await vi.waitFor(() => expect(manager.connections().find((item) => item.source === source)).toMatchObject({
      status: "ready", identity, bound: true,
    }));
    const saved = await store.load(source);
    expect(launcher.open).toHaveBeenCalledWith(store.profilePath(saved.binding!.profile!), provider.loginUrl, true);
    expect(provider.identify).toHaveBeenCalledTimes(2);
    expect(login.close).toHaveBeenCalledOnce();
    expect(saved.binding?.session).toEqual({ version: 1, source, localStorage: initialStorage });
    expect(JSON.stringify(manager.connections())).not.toMatch(/test-access|test-refresh|localStorage|private-value|private-cookie/);

    await manager.sync(source);
    expect(launcher.openPortable).toHaveBeenLastCalledWith(saved.binding?.session, provider.loginUrl);
    expect((await store.load(source)).binding?.session).toEqual({ version: 1, source, localStorage: renewedStorage });
    expect(headless.close).toHaveBeenCalledOnce();
    await manager.close();
    await store.removeProfile(saved.binding!.profile!);
    close();

    const { store: reopenedStore } = openStore(path);
    const restart = new SourceManager({ ...options, store: reopenedStore });
    managers.push(restart);
    await restart.initialize();
    await restart.sync(source);
    expect(launcher.openPortable).toHaveBeenLastCalledWith({ version: 1, source, localStorage: renewedStorage }, provider.loginUrl);
    expect(launcher.open).toHaveBeenCalledOnce();
    expect(provider.fetchScores).toHaveBeenCalledWith(headless.session, identity, expect.any(Function));
    await restart.unbind(source);
    expect((await reopenedStore.load(source)).binding).toBeNull();
  });
});
