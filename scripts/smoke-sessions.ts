import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SourceStore } from "../server/store";
import { SourceManager } from "../server/manager";
import { browserLauncher } from "../server/browser";
import { requireIdentity, SyncError, type BrowserProvider, type BrowserSession } from "../server/provider";
import { catalog } from "../src/core/catalog";

// A local fake portal exercises real browser persistence without accessing any personal account.
const portal = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end('<html><button onclick="localStorage.setItem(\'auth\',\'fixture-session\')">模拟登录</button></html>');
});
await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
const address = portal.address();
assert(address && typeof address !== "string");
const directory = await mkdtemp(join(tmpdir(), "machun-session-smoke-"));
const store = new SourceStore(directory);
let opened: BrowserSession | undefined;
const identity = { id: "fixture-user", label: "测试玩家", cardId: "fixture-card" };
const provider: BrowserProvider = {
  source: "rin", loginUrl: `http://127.0.0.1:${address.port}/login`,
  async identify(session) {
    if (await session.page.evaluate(() => localStorage.getItem("auth")) !== "fixture-session") {
      throw new SyncError("AUTH_REQUIRED", "等待模拟登录", 401);
    }
    return identity;
  },
  async fetchScores(session, expected) {
    requireIdentity(await this.identify(session), expected);
    return { userMusicDetailList: [{ musicId: catalog[0].id, level: catalog[0].difficulty, scoreMax: 1_005_000 }] };
  },
};
const options = {
  store, providers: { rin: provider, munet: provider, otogame: provider }, bindPollMs: 50, bindTimeoutMs: 20_000,
  launcher: { async open(path: string, url: string) { opened = await browserLauncher.open(path, url, false); return opened; } },
};
const first = new SourceManager(options);
const restored = new SourceManager(options);
async function waitUntil(condition: () => boolean) {
  const deadline = Date.now() + 20_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Browser session smoke timed out");
    await delay(50);
  }
}
try {
  await first.initialize();
  await first.bind("rin");
  await waitUntil(() => Boolean(opened));
  await opened!.page.getByRole("button", { name: "模拟登录" }).click();
  await waitUntil(() => first.connections().some((connection) => connection.source === "rin" && connection.status === "ready"));
  const saved = await store.load("rin");
  assert(saved.binding?.profile);
  await first.close();
  await restored.initialize();
  const result = await restored.sync("rin");
  assert.equal(result.records[0]?.score, 1_005_000);
  assert.equal(result.connection.identity?.id, identity.id);
  assert(!JSON.stringify(result).includes("fixture-session"));
  await restored.unbind("rin");
  await assert.rejects(stat(store.profilePath(saved.binding.profile)), { code: "ENOENT" });
  assert.equal(restored.connections().find((connection) => connection.source === "rin")?.bound, false);
  console.log("PASS: real isolated browser login, persisted session after service restart, score sync, and profile removal on unbind");
} finally {
  await first.close();
  await restored.close();
  await new Promise<void>((resolve) => { portal.close(() => resolve()); portal.closeAllConnections(); });
  await rm(directory, { recursive: true, force: true });
}
