import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { connect, type Socket } from "node:net";
import { createServer, request as httpRequest, type Server, type IncomingHttpHeaders } from "node:http";
import { createAppServer, type HttpManager } from "./http";
import type { SourceConnection } from "../src/syncTypes";

const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })));
});
const password = "fixture-deployment-password";
const authorization = `Basic ${Buffer.from(`machun:${password}`).toString("base64")}`;
const publicOrigin = "https://scores.example";
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}
async function setup(noConfiguration = false) {
  let active = false;
  let session = "fixture-1";
  let upstreamHeaders: IncomingHttpHeaders | undefined;
  const desktop = createServer((request, response) => {
    upstreamHeaders = request.headers;
    response.setHeader("Content-Type", "text/html");
    response.end(`<html>${request.url}</html>`);
  });
  desktop.on("connection", (socket) => sockets.push(socket));
  desktop.on("upgrade", (request, socket) => {
    upstreamHeaders = request.headers;
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("data", (data) => socket.write(data));
    socket.on("error", () => undefined);
  });
  const remoteDesktopPort = await listen(desktop);
  const connection: SourceConnection = { source: "rin", status: "binding", bound: false, identity: null, lastAttemptAt: null, lastSuccessAt: null, error: null };
  const manager: HttpManager = { connections: () => active ? [{ ...connection, loginUrl: `/login-view/vnc.html?session=${session}` }] : [], bind: vi.fn(), unbind: vi.fn(), sync: vi.fn() };
  const server = createAppServer({ manager, ...(noConfiguration ? { allowRequestHost: true } : { publicOrigin, accessPassword: password }), remoteDesktopPort });
  const port = await listen(server);
  const send = (path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path, headers: { Host: "scores.example", ...headers } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    request.on("error", reject);
    request.end();
  });
  const handshake = (headers: Record<string, string> = {}) => new Promise<{ response: string; socket: Socket }>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    sockets.push(socket);
    socket.on("error", reject);
    socket.once("data", (data) => resolve({ response: data.toString(), socket }));
    socket.once("connect", () => socket.write(`GET /login-view/websockify HTTP/1.1\r\nHost: scores.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("")}\r\n`));
  });
  return { send, handshake, setActive: (value: boolean) => { active = value; }, nextSession: () => { session = "fixture-2"; }, upstream: () => upstreamHeaders };
}

describe("authenticated deployment and private desktop", () => {
  it("allows the unprotected desktop in the default mode while requiring same-origin WebSockets", async () => {
    const { send, handshake, setActive } = await setup(true);
    expect((await send("/api/sources")).status).toBe(200);
    expect((await send("/login-view/vnc.html")).status).toBe(409);
    setActive(true);
    expect((await send("/login-view/vnc.html", { Origin: publicOrigin })).status).toBe(200);
    expect((await handshake({ Origin: publicOrigin })).response).toContain("101 Switching Protocols");
    expect((await handshake({ Origin: "https://another.example" })).response).toContain("403");
    expect((await handshake()).response).toContain("403");
    setActive(false);
  });
  it("exposes only health without authentication and enforces the configured Host and Origin", async () => {
    const { send } = await setup();
    expect((await send("/healthz")).status).toBe(200);
    const denied = await send("/api/sources");
    expect(denied.status).toBe(401);
    expect(denied.headers["www-authenticate"]).toContain("Basic");
    expect((await send("/api/sources", { Authorization: authorization, Origin: publicOrigin })).status).toBe(200);
    expect((await send("/api/sources", { Authorization: authorization, Host: "other.example" })).status).toBe(403);
    expect((await send("/api/sources", { Authorization: authorization, Origin: "http://scores.example" })).status).toBe(403);
    expect((await send("/api/sources", { Authorization: authorization, "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
  });
  it("serves iframe assets only for an active binding and never forwards credentials", async () => {
    const { send, setActive, upstream } = await setup();
    expect((await send("/login-view/vnc.html", { Authorization: authorization })).status).toBe(409);
    setActive(true);
    const page = await send("/login-view/vnc.html", { Authorization: authorization, Cookie: "private=secret", Origin: publicOrigin });
    expect(page).toMatchObject({ status: 200, body: "<html>/vnc.html</html>" });
    expect(page.headers["content-security-policy"]).toBe("frame-ancestors 'self'");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(upstream()).not.toHaveProperty("authorization");
    expect(upstream()).not.toHaveProperty("cookie");
    expect(upstream()).not.toHaveProperty("origin");
    expect((await send("/login-view/utils/websockify", { Authorization: authorization })).status).toBe(404);
    expect((await send("/login-view/app/..%2fprivate", { Authorization: authorization })).status).toBe(404);
  });
  it("requires both authentication and same-origin proof for WebSockets", async () => {
    const { handshake, setActive } = await setup();
    setActive(true);
    expect((await handshake({ Origin: publicOrigin })).response).toContain("401");
    expect((await handshake({ Authorization: authorization })).response).toContain("403");
    expect((await handshake({ Authorization: authorization, Origin: "https://attacker.example" })).response).toContain("403");
    setActive(false);
    expect((await handshake({ Authorization: authorization, Origin: publicOrigin })).response).toContain("409");
  });
  it("authenticates via the session cookie, tunnels data, and closes a previous binding's desktop", async () => {
    const { send, handshake, setActive, nextSession, upstream } = await setup();
    const status = await send("/api/sources", { Authorization: authorization });
    const cookie = status.headers["set-cookie"]![0].split(";")[0];
    setActive(true);
    const { response, socket } = await handshake({ Cookie: cookie, Origin: publicOrigin });
    expect(response).toContain("101 Switching Protocols");
    expect(upstream()).not.toHaveProperty("cookie");
    const echoed = new Promise<string>((resolve) => socket.once("data", (data) => resolve(data.toString())));
    socket.write("desktop-fixture");
    expect(await echoed).toBe("desktop-fixture");
    nextSession();
    await vi.waitFor(() => expect(socket.destroyed).toBe(true), { timeout: 1500 });
  });
});
