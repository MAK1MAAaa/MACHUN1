/** Isolated mobile and embedded manual-login checks; no personal credentials. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createAppServer, type HttpManager } from "../server/http";
import { catalog } from "../src/core/catalog";
import { calculateRating } from "../src/core/rating";
import { STORAGE_KEY } from "../src/core/storage";
import { SYNC_SOURCES, type SourceConnection } from "../src/syncTypes";

const directory = await mkdtemp(join(tmpdir(), "machun-mobile-smoke-"));
const state: SourceConnection[] = SYNC_SOURCES.map((source) => ({ source, status: "unbound", bound: false, identity: null, error: null, lastAttemptAt: null, lastSuccessAt: null }));
const manager: HttpManager = {
  connections: () => structuredClone(state),
  async bind(source) {
    const connection = state.find((item) => item.source === source)!;
    Object.assign(connection, { status: "binding", loginUrl: "/login-view/vnc.html?autoconnect=true" });
    return structuredClone(connection);
  },
  async unbind(source) {
    const connection = state.find((item) => item.source === source)!;
    Object.assign(connection, { status: "unbound", bound: false });
    delete connection.loginUrl;
    return structuredClone(connection);
  },
  async sync() { throw new Error("not used"); },
};
const desktop = createServer((request, response) => {
  if (request.url === "/app/complete") {
    const connection = state.find((item) => item.status === "binding")!;
    Object.assign(connection, { status: "ready", bound: true, identity: { id: "fixture-player", label: "模拟手动登录" } });
    delete connection.loginUrl;
    response.end("ok");
  } else {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end('<!doctype html><label>测试账号<input autocomplete="off"></label><button onclick="fetch(\'/login-view/app/complete\')">完成模拟登录</button>');
  }
});
await new Promise<void>((resolve) => desktop.listen(0, "127.0.0.1", resolve));
const desktopAddress = desktop.address();
assert(desktopAddress && typeof desktopAddress !== "string");
const server = createAppServer({ manager, distDirectory: "dist", remoteDesktopPort: desktopAddress.port });
let browser;
try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const seed = { schemaVersion: 2, nicknameOverrides: {}, scores: Object.fromEntries(catalog.slice(0, 50).map((chart) => [`${chart.id}:${chart.difficulty}`, { ...chart, score: 1_009_000, rating: calculateRating(1_009_000, chart.constant), source: "manual", updatedAt: "2026-10-08T00:00:00Z", combo: "aj" }])) };
  await context.addInitScript({ content: `if(location.origin===${JSON.stringify(origin)})localStorage.setItem(${JSON.stringify(STORAGE_KEY)},${JSON.stringify(JSON.stringify(seed))});` });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  await page.locator(".b30-preview-toggle").click();
  for (const [width, columns] of [[320, 1], [390, 1], [768, 2], [1440, 3]]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.locator(".b30-grid").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length), columns);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `viewport ${width} overflows`);
    assert.equal(await page.locator(".b30-card").count(), 30);
    if (width === 390) await page.locator(".b30-section").screenshot({ path: join(directory, "mobile-b30.png") });
  }
  await page.setViewportSize({ width: 320, height: 720 });
  const records = page.locator(".records-section");
  await records.getByRole("button", { name: "曲库筛选", exact: true }).click();
  const difficulty = records.getByLabel("难度", { exact: true });
  assert.equal(await difficulty.evaluate((element) => getComputedStyle(element).fontSize), "16px");
  assert.equal(await difficulty.evaluate((element) => element.getBoundingClientRect().height), 44);
  await records.getByLabel("等级", { exact: true }).selectOption("13+");
  await records.getByRole("button", { name: "显示未游玩谱面", exact: true }).click();
  await records.locator(".record-title-details").first().click();
  await page.locator(".song-details-dialog[open]").waitFor();
  assert(await page.locator(".song-details-dialog").evaluate((element) => element.scrollWidth <= element.clientWidth));
  await page.screenshot({ path: join(directory, "mobile-song-details.png") });
  await page.getByRole("button", { name: "关闭歌曲详情" }).click();
  await page.locator(".source-tools-toggle").click();
  const source = page.locator(".source-card.rin");
  await source.getByRole("button", { name: "绑定账号", exact: true }).click();
  await page.locator(".remote-login-dialog[open]").waitFor();
  const iframe = page.frameLocator('iframe[title="Rin服手动登录窗口"]');
  await iframe.getByRole("button", { name: "完成模拟登录" }).waitFor();
  await page.screenshot({ path: join(directory, "mobile-login.png") });
  assert(await page.locator(".remote-login-dialog").evaluate((element) => element.scrollWidth <= element.clientWidth));
  await page.getByRole("button", { name: "返回成绩页面", exact: true }).click();
  assert.equal(await page.locator(".remote-login-dialog").count(), 0);
  await source.getByRole("button", { name: "打开登录窗口", exact: true }).click();
  await iframe.getByRole("button", { name: "完成模拟登录" }).click();
  await source.locator(".source-connection-status").filter({ hasText: /^已绑定$/ }).waitFor();
  assert.equal(await page.locator(".remote-login-dialog").count(), 0);
  assert(await source.getByRole("button", { name: "同步成绩", exact: true }).isEnabled());
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  console.log(`PASS: 320/390/768/1440 layouts, touch filters, song dialog, manual-login reopen and automatic return. Screenshots: ${directory}`);
} finally {
  await browser?.close();
  await Promise.all([server, desktop].map((item) => new Promise<void>((resolve) => { item.close(() => resolve()); item.closeAllConnections(); })));
}
