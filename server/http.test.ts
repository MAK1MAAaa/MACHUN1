import { afterEach, describe, expect, it, vi } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAppServer, type HttpManager, type HttpOptions } from "./http";
import { SyncError } from "./provider";
import type { SourceConnection, SyncResult } from "../src/syncTypes";

const servers: Server[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup(options: Partial<HttpOptions> = {}) {
  const connection: SourceConnection = { source: "rin", status: "ready", bound: true, identity: { id: "1", label: "玩家" }, lastAttemptAt: null, lastSuccessAt: null, error: null };
  const manager: HttpManager = {
    connections: vi.fn(() => [connection]), bind: vi.fn(async () => connection), unbind: vi.fn(async () => connection),
    sync: vi.fn(async (): Promise<SyncResult> => ({ source: "rin", records: [], report: { parsedScores: 0, importedScores: 0, updatedScores: 0, skippedScores: 0, unknownCharts: 0, invalidEntries: 0 }, connection })),
  };
  const directory = await mkdtemp(join(tmpdir(), "machun-http-"));
  directories.push(directory);
  const dist = join(directory, "dist");
  await mkdir(dist);
  await writeFile(join(dist, "index.html"), "<html>local app</html>");
  await mkdir(join(directory, ".machun.local"));
  await writeFile(join(directory, ".machun.local", "lxns.json"), "secret-vault");
  const server = createAppServer({ manager, distDirectory: dist, additionalOrigins: ["http://127.0.0.1:4399"], ...options });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const port = address.port;
  const send = (path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) => new Promise<{ status: number; text: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode!, text: Buffer.concat(chunks).toString(), headers: response.headers }));
    });
    request.on("error", reject);
    request.end(options.body);
  });
  return { manager, send, port };
}

const writeHeaders = { "Content-Type": "application/json", "X-Machun-Request": "1" };

describe("local HTTP boundary", () => {
  it("accepts IP and reverse-proxy hosts without environment setup while rejecting foreign origins", async () => {
    const { send, manager } = await setup({ allowRequestHost: true });
    for (const [host, origin] of [["192.0.2.10:1650", "http://192.0.2.10:1650"], ["chuni.example", "https://chuni.example"], ["[2001:db8::1]:1650", "http://[2001:db8::1]:1650"]]) {
      const status = await send("/api/sources", { headers: { Host: host, Origin: origin } });
      expect(status.status).toBe(200);
      expect(status.headers["www-authenticate"]).toBeUndefined();
      expect((await send("/api/sources/rin/sync", { method: "POST", headers: { ...writeHeaders, Host: host, Origin: origin }, body: "{}" })).status).toBe(200);
    }
    expect(manager.sync).toHaveBeenCalledTimes(3);
    for (const origin of ["https://another.example", "http://192.0.2.10:1651", "null"]) {
      expect((await send("/api/sources", { headers: { Host: "192.0.2.10:1650", Origin: origin } })).status).toBe(403);
    }
    expect((await send("/api/sources", { headers: { Host: "192.0.2.10:1650", "X-Forwarded-Host": "another.example", Origin: "https://another.example" } })).status).toBe(403);
  });
  it("rejects malformed dynamic hosts and cross-site API requests", async () => {
    const { send } = await setup({ allowRequestHost: true });
    for (const host of ["user@chuni.example", "chuni.example/path", "chuni.example?query", "chuni.example:bad", "chuni.example,another.example"]) {
      expect((await send("/api/sources", { headers: { Host: host } })).status).toBe(403);
    }
    expect((await send("/api/sources", { headers: { Host: "chuni.example", "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
  });
  it("allows opening the page from a panel link without allowing cross-site API navigation", async () => {
    const { send } = await setup({ allowRequestHost: true });
    const headers = { Host: "192.0.2.10:1650", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
    expect((await send("/", { headers })).status).toBe(200);
    expect((await send("/api/sources", { headers })).status).toBe(403);
    expect((await send("/other/../api/sources", { headers })).status).toBe(403);
    expect((await send("/other/../login-view/vnc.html", { headers })).status).toBe(403);
  });
  it("serves the app and safe status metadata", async () => {
    const { send } = await setup();
    expect(await send("/")).toMatchObject({ status: 200, text: "<html>local app</html>" });
    const status = await send("/api/sources");
    expect(status.status).toBe(200);
    expect(status.headers["cache-control"]).toBe("no-store");
    expect(status.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects forged hosts, cross-site origins and simple form requests", async () => {
    const { send, manager } = await setup();
    expect((await send("/api/sources", { headers: { Host: "attacker.example" } })).status).toBe(403);
    expect((await send("/api/sources", { headers: { Origin: "https://attacker.example" } })).status).toBe(403);
    expect((await send("/api/sources/rin/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await send("/api/sources/rin/sync", { method: "POST", headers: { ...writeHeaders, "Content-Type": "text/plain" }, body: "{}" })).status).toBe(415);
    expect(manager.sync).not.toHaveBeenCalled();
  });

  it("accepts same-origin writes, rejects arbitrary sources and invalid methods", async () => {
    const { send, manager, port } = await setup();
    expect((await send("/api/sources/rin/sync", { method: "POST", headers: { ...writeHeaders, Origin: `http://127.0.0.1:${port}` }, body: "{}" })).status).toBe(200);
    expect(manager.sync).toHaveBeenCalledWith("rin");
    expect((await send("/api/sources/unknown/sync", { method: "POST", headers: writeHeaders })).status).toBe(404);
    expect((await send("/api/sources/rin/sync")).status).toBe(405);
  });

  it("permits explicit Otogame full calibration and rejects malformed or unrelated options", async () => {
    const { send, manager } = await setup();
    expect((await send("/api/sources/otogame/sync", { method: "POST", headers: writeHeaders, body: '{"full":true}' })).status).toBe(200);
    expect(manager.sync).toHaveBeenCalledExactlyOnceWith("otogame", { full: true });
    for (const [source, full] of [["rin", true], ["otogame", "true"]] as const) {
      expect((await send(`/api/sources/${source}/sync`, { method: "POST", headers: writeHeaders, body: JSON.stringify({ full }) })).status).toBe(400);
    }
    expect(manager.sync).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed and oversized JSON before running source operations", async () => {
    const { send, manager } = await setup();
    for (const content of ["not-json", "[]"]) {
      expect((await send("/api/sources/lxns/bind", { method: "POST", headers: writeHeaders, body: content })).status).toBe(400);
    }
    expect((await send("/api/sources/lxns/bind", { method: "POST", headers: writeHeaders, body: JSON.stringify({ token: "x".repeat(17_000) }) })).status).toBe(413);
    expect(manager.bind).not.toHaveBeenCalled();
  });

  it("cannot serve the credential vault, dotfiles or encoded parent traversal", async () => {
    const { send } = await setup();
    for (const path of ["/.machun.local/lxns.json", "/..%2f.machun.local/lxns.json", "/%2e%2e/.machun.local/lxns.json", "/.env"]) {
      const response = await send(path);
      expect(response.status).toBe(404);
      expect(response.text).not.toContain("secret-vault");
    }
  });

  it("returns controlled source errors but strips unexpected exception messages", async () => {
    const { send, manager } = await setup();
    vi.mocked(manager.sync).mockRejectedValueOnce(new Error("Authorization: private-token"));
    const failure = await send("/api/sources/rin/sync", { method: "POST", headers: writeHeaders, body: "{}" });
    expect(failure.status).toBe(500);
    expect(failure.text).not.toContain("private-token");
    vi.mocked(manager.sync).mockRejectedValueOnce(new SyncError("AUTH_REQUIRED", "请重新登录", 401));
    expect((await send("/api/sources/rin/sync", { method: "POST", headers: writeHeaders, body: "{}" })).status).toBe(401);
  });
});
