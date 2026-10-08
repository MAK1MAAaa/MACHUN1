// Mounted only by smoke-docker.mjs. A local portal tests the real container browser.
import { createServer } from "node:http";
import { SourceStore } from "../server/store";
import { SourceManager } from "../server/manager";
import { createAppServer } from "../server/http";
import { runtimeConfig } from "../server/config";
import { requireIdentity, SyncError, type BrowserProvider } from "../server/provider";
import { catalog } from "../src/core/catalog";

const config = runtimeConfig(process.env, "/app");
const portal = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end('<!doctype html><title>模拟手动登录</title><h1>Docker 手动登录测试</h1><button style="position:absolute;left:120px;top:130px;width:240px;height:60px;font-size:24px;background:rgb(18,146,112);color:white" onclick="localStorage.setItem(\'auth\',\'fixture-session\')">模拟登录</button>');
});
await new Promise<void>((resolve) => portal.listen(4401, "127.0.0.1", resolve));
const identity = { id: "fixture-player", label: "容器模拟玩家", cardId: "fixture-card" };
const provider: BrowserProvider = {
  source: "rin", loginUrl: "http://127.0.0.1:4401/login",
  async identify(session) {
    if (await session.page.evaluate(() => localStorage.getItem("auth")) !== "fixture-session") throw new SyncError("AUTH_REQUIRED", "等待手动模拟登录", 401);
    return identity;
  },
  async fetchScores(session, expected) {
    requireIdentity(await this.identify(session), expected);
    return { userMusicDetailList: [{ musicId: catalog[0].id, level: catalog[0].difficulty, scoreMax: 1_009_000, isAllJustice: true }] };
  },
};
const manager = new SourceManager({
  store: new SourceStore(config.dataDirectory), providers: { rin: provider, munet: provider, otogame: provider },
  remoteLogin: true, bindPollMs: 200,
});
await manager.initialize();
const server = createAppServer({ manager, distDirectory: "/app/dist", publicOrigin: config.publicOrigin, accessPassword: config.accessPassword, remoteDesktopPort: 6080 });
server.listen(config.port, config.host);
async function stop() { server.close(); await manager.close(); portal.close(); portal.closeAllConnections(); }
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
