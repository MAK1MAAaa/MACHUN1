import { request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { SyncError } from "./provider";

interface DesktopOptions {
  port: number;
  active: () => string | undefined;
  validate: (request: IncomingMessage, websocket?: boolean) => void;
  authenticate: (request: IncomingMessage, response?: ServerResponse) => boolean;
}

function internalHeaders(request: IncomingMessage) {
  const headers = { ...request.headers };
  // The desktop is private to the container; deployment credentials never reach it.
  for (const name of ["authorization", "cookie", "origin", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"]) delete headers[name];
  headers.host = "127.0.0.1";
  return headers;
}

function assetPath(path: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { throw new SyncError("NOT_FOUND", "登录窗口文件不存在。", 404); }
  if (decoded.split("/").some((part) => part.startsWith(".")) || decoded.includes("\\")
    || !/^\/login-view\/(?:vnc\.html|(?:app|core|vendor)\/.+|defaults\.json|mandatory\.json)$/.test(decoded)) {
    throw new SyncError("NOT_FOUND", "登录窗口文件不存在。", 404);
  }
  return decoded.slice("/login-view".length);
}

export function attachDesktopProxy(server: Server, options: DesktopOptions) {
  const tunnels = new Map<Duplex, string>();
  server.on("upgrade", (request, socket, head) => {
    let status = 403;
    let binding: string | undefined;
    try {
      options.validate(request, true);
      if (!options.authenticate(request)) { status = 401; throw new Error("auth"); }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method !== "GET" || url.pathname !== "/login-view/websockify" || url.search) { status = 404; throw new Error("path"); }
      binding = options.active();
      if (!binding) { status = 409; throw new Error("inactive"); }
    } catch {
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const upstream = httpRequest({ hostname: "127.0.0.1", port: options.port, path: "/websockify", headers: internalHeaders(request) });
    upstream.setTimeout(15_000, () => upstream.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    upstream.on("response", (response) => { response.resume(); socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); });
    upstream.on("upgrade", (response, desktop, desktopHead) => {
      if (options.active() !== binding || socket.destroyed) { desktop.destroy(); socket.destroy(); return; }
      upstream.setTimeout(0);
      desktop.setTimeout(0);
      const headers = ["HTTP/1.1 101 Switching Protocols"];
      for (const name of ["upgrade", "connection", "sec-websocket-accept", "sec-websocket-protocol"]) {
        if (response.headers[name]) headers.push(`${name}: ${response.headers[name]}`);
      }
      socket.write(`${headers.join("\r\n")}\r\n\r\n`);
      if (desktopHead.length) socket.write(desktopHead);
      if (head.length) desktop.write(head);
      tunnels.set(socket, binding!);
      desktop.on("error", () => socket.destroy());
      desktop.on("close", () => socket.destroy());
      socket.on("close", () => { tunnels.delete(socket); desktop.destroy(); });
      desktop.pipe(socket);
      socket.pipe(desktop);
    });
    upstream.end();
  });
  // A dismissed or completed binding must not leave a reusable desktop connection.
  const timer = setInterval(() => { for (const [tunnel, binding] of tunnels) if (binding !== options.active()) tunnel.destroy(); }, 500);
  timer.unref();
  server.on("close", () => { clearInterval(timer); for (const tunnel of tunnels.keys()) tunnel.destroy(); });

  return async (request: IncomingMessage, response: ServerResponse, path: string): Promise<void> => {
    if (!options.active()) throw new SyncError("LOGIN_INACTIVE", "请先开始绑定账号，再打开登录窗口。", 409);
    if (request.method !== "GET" && request.method !== "HEAD") throw new SyncError("METHOD_NOT_ALLOWED", "不支持该请求方法。", 405);
    const target = assetPath(path);
    await new Promise<void>((resolve, reject) => {
      const upstream = httpRequest({ hostname: "127.0.0.1", port: options.port, path: target, method: request.method, headers: internalHeaders(request) }, (desktop) => {
        const headers = { ...desktop.headers, "cache-control": "no-store", "content-security-policy": "frame-ancestors 'self'", "x-content-type-options": "nosniff" };
        delete headers["set-cookie"];
        response.writeHead(desktop.statusCode ?? 502, headers);
        desktop.on("error", reject);
        desktop.on("end", resolve);
        desktop.pipe(response);
      });
      upstream.setTimeout(15_000, () => upstream.destroy(new Error("timeout")));
      upstream.on("error", () => reject(new SyncError("DESKTOP_UNAVAILABLE", "登录窗口尚未就绪，请稍后重新打开。", 503)));
      response.on("close", () => upstream.destroy());
      upstream.end();
    });
  };
}
