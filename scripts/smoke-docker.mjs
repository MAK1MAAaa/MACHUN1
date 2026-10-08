/** Builds separately: pnpm docker:package. Tests use fresh containers/volumes and a fake portal. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const unique = `machun1-smoke-${Date.now()}`;
const volume = `${unique}-data`;
const password = "fixture-container-access-password";
const authorization = `Basic ${Buffer.from(`machun:${password}`).toString("base64")}`;
const image = "machun1:manual-login-amd64";
const directory = await mkdtemp(join(tmpdir(), "machun-docker-smoke-"));
async function docker(args) {
  const child = spawn("docker", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const chunks = [];
  const errors = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stderr.on("data", (chunk) => errors.push(chunk));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(Buffer.concat(chunks).toString().trim()) : reject(new Error(`docker ${args[0]} failed: ${Buffer.concat(errors)}`)));
  });
}
async function unusedPort() {
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}
const port = await unusedPort();
const origin = `http://127.0.0.1:${port}`;
async function healthy() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1500) })).ok) return; } catch { /* starting */ }
    await delay(500);
  }
  throw new Error(`Container startup failed: ${await docker(["logs", "--tail", "15", unique])}`);
}
const api = (path, method = "GET") => fetch(`${origin}${path}`, { method, headers: { Authorization: authorization, Origin: origin, "X-Machun-Request": "1", "Content-Type": "application/json" }, ...(method !== "GET" ? { body: "{}" } : {}), signal: AbortSignal.timeout(90_000) });
let browser;
try {
  assert.equal(await docker(["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", image]), "linux/amd64");
  const options = ["--name", unique, "--platform", "linux/amd64", "--shm-size", "1g", "-p", `127.0.0.1:${port}:4399`, "-e", `MACHUN_PUBLIC_ORIGIN=${origin}`, "-e", `MACHUN_ACCESS_PASSWORD=${password}`, "-v", `${volume}:/data`];
  await docker(["run", "-d", ...options, image]);
  await healthy();
  assert.equal((await fetch(`${origin}/api/sources`)).status, 401);
  assert.equal((await api("/api/sources")).status, 200);
  assert.equal((await api("/login-view/vnc.html")).status, 409);
  assert.equal(await docker(["exec", unique, "id", "-u"]), "1000");
  assert.equal(await docker(["exec", unique, "stat", "-c", "%a", "/data"]), "700");
  await docker(["exec", unique, "node", "-e", "const fs=require('fs');for(const p of ['/app/.env','/app/.machun.local','/app/server/credentials.ts','/app/server/portalLogin.ts']){if(fs.existsSync(p))process.exit(1)}"]);
  console.log("PASS container startup, access password, non-root permissions and exclusion of local credentials/automatic login");
  await docker(["rm", "-f", unique]);
  await docker(["run", "-d", ...options, "--mount", `type=bind,source=${resolve(root, "scripts/docker-session-fixture.ts")},target=/app/scripts/docker-session-fixture.ts,readonly`, image, "node", "node_modules/tsx/dist/cli.mjs", "scripts/docker-session-fixture.ts"]);
  await healthy();
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, httpCredentials: { username: "machun", password } });
  await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  await page.locator(".source-tools-toggle").click();
  const source = page.locator(".source-card.rin");
  await source.getByRole("button", { name: "绑定账号", exact: true }).click();
  await page.locator(".remote-login-dialog[open]").waitFor();
  const frame = page.frameLocator('iframe[title="Rin服手动登录窗口"]');
  const canvas = frame.locator("canvas");
  await canvas.waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const iframe = document.querySelector(".remote-login-dialog iframe");
    return iframe?.contentDocument?.querySelector("canvas")?.width >= 1000;
  });
  let coordinates;
  const readyBy = Date.now() + 60_000;
  while (Date.now() < readyBy) {
    // Browser viewport emulation changes screenX/outerHeight; use the actual VNC pixels.
    coordinates = await canvas.evaluate((element) => {
      const { data } = element.getContext("2d").getImageData(0, 0, element.width, element.height);
      let minX = element.width, minY = element.height, maxX = 0, maxY = 0, count = 0;
      for (let y = 0; y < element.height; y += 2) for (let x = 0; x < element.width; x += 2) {
        const offset = (y * element.width + x) * 4;
        if (Math.abs(data[offset] - 18) < 10 && Math.abs(data[offset + 1] - 146) < 10 && Math.abs(data[offset + 2] - 112) < 10) {
          minX = Math.min(x, minX); minY = Math.min(y, minY); maxX = Math.max(x, maxX); maxY = Math.max(y, maxY); count++;
        }
      }
      return count > 100 ? { x: (minX + maxX) / 2, y: (minY + maxY) / 2 } : undefined;
    });
    if (coordinates) break;
    await delay(500);
  }
  assert(coordinates, "visible browser did not reach the fixture portal");
  await page.screenshot({ path: join(directory, "desktop-real-login.png") });
  const size = await canvas.evaluate((element) => ({ width: element.width, height: element.height }));
  const bounds = await canvas.boundingBox();
  assert(bounds);
  await page.mouse.click(bounds.x + coordinates.x * bounds.width / size.width, bounds.y + coordinates.y * bounds.height / size.height);
  await source.locator(".source-connection-status").filter({ hasText: /^已绑定$/ }).waitFor();
  assert.equal(await page.locator(".remote-login-dialog").count(), 0);
  let result = await (await api("/api/sources/rin/sync", "POST")).json();
  assert.equal(result.records[0].score, 1_009_000);
  assert.equal(result.records[0].combo, "aj");
  await docker(["restart", unique]);
  await healthy();
  result = await (await api("/api/sources/rin/sync", "POST")).json();
  assert.equal(result.records[0].score, 1_009_000);
  assert.equal((await api("/login-view/vnc.html")).status, 409);
  await api("/api/sources/rin/binding", "DELETE");
  assert.equal(await docker(["exec", unique, "node", "-e", "console.log(require('fs').readdirSync('/data/profiles').length)"]), "0");
  assert.deepEqual(errors, []);
  console.log(`PASS real noVNC mouse login, automatic return, AJ score sync, restart persistence and profile removal. Screenshots: ${directory}`);
} finally {
  await browser?.close();
  await docker(["rm", "-f", unique]).catch(() => undefined);
  await docker(["volume", "rm", volume]).catch(() => undefined);
}
