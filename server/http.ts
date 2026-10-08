import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { SYNC_SOURCES } from "../src/syncTypes";
import type { ExternalScoreSource } from "../src/core/sources";
import type { SourceManager } from "./manager";
import { safeError } from "./manager";
import { SyncError } from "./provider";
import { createAccessGate } from "./access";
import { attachDesktopProxy } from "./desktopProxy";

export type HttpManager = Pick<SourceManager, "connections" | "bind" | "unbind" | "sync">;

export interface HttpOptions {
  manager: HttpManager;
  distDirectory?: string;
  additionalOrigins?: string[];
  publicOrigin?: string;
  accessPassword?: string;
  allowRequestHost?: boolean;
  remoteDesktopPort?: number;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(body));
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new SyncError("INVALID_REQUEST", "请求必须使用 JSON。", 415);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > 16 * 1024) throw new SyncError("INVALID_REQUEST", "请求内容过大。", 413);
    chunks.push(Buffer.from(chunk));
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return parsed as Record<string, unknown>;
  } catch { throw new SyncError("INVALID_REQUEST", "JSON 请求无效。", 400); }
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

export function createAppServer(options: HttpOptions) {
  const authenticate = createAccessGate(options.accessPassword, options.publicOrigin?.startsWith("https://"));
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (response.headersSent) { response.destroy(); return; }
      const safe = safeError(error);
      json(response, safe.status, { code: safe.code, error: safe.message });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  function validate(request: IncomingMessage, websocket = false): void {
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (options.publicOrigin) allowedHosts.add(new URL(options.publicOrigin).host);
    const host = request.headers.host ?? "";
    let requestAddress: URL | undefined;
    if (options.allowRequestHost) {
      try {
        if (!host || /[\s\\/@?#,]/.test(host)) throw new Error("invalid host");
        requestAddress = new URL(`http://${host}`);
        if (!requestAddress.hostname || requestAddress.pathname !== "/") throw new Error("invalid host");
      } catch { throw new SyncError("FORBIDDEN", "不允许的访问地址。", 403); }
    } else if (!allowedHosts.has(host)) throw new SyncError("FORBIDDEN", "不允许的访问地址。", 403);
    const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...(options.additionalOrigins ?? [])]);
    if (options.publicOrigin) allowedOrigins.add(options.publicOrigin);
    const origin = request.headers.origin;
    let sameOrigin = origin ? allowedOrigins.has(origin) : true;
    if (origin && requestAddress) {
      try {
        const address = new URL(origin);
        // Accept HTTP or HTTPS behind a proxy, but never trust a forwarded Host.
        sameOrigin = ["http:", "https:"].includes(address.protocol) && address.origin === origin
          && address.host === new URL(`${address.protocol}//${host}`).host;
      } catch { sameOrigin = false; }
    }
    const topLevelNavigation = !websocket && request.method === "GET" && request.headers["sec-fetch-mode"] === "navigate"
      && request.headers["sec-fetch-dest"] === "document" && !/^\/(?:api|login-view)(?:\/|$)/.test(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    if (!sameOrigin || (websocket && !origin) || (request.headers["sec-fetch-site"] === "cross-site" && !topLevelNavigation)) {
      throw new SyncError("FORBIDDEN", "不允许跨站访问服务。", 403);
    }
  }
  const desktop = options.remoteDesktopPort ? attachDesktopProxy(server, {
    port: options.remoteDesktopPort, authenticate, validate,
    active: () => options.manager.connections().find((item) => item.status === "binding" && item.loginUrl)?.loginUrl,
  }) : undefined;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    validate(request);
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const method = request.method ?? "GET";
    if (path === "/healthz" && method === "GET") { json(response, 200, { status: "ok" }); return; }
    if (!authenticate(request, response)) {
      response.setHeader("WWW-Authenticate", 'Basic realm="MACHUN1", charset="UTF-8"');
      throw new SyncError("ACCESS_REQUIRED", "请输入部署访问账号和密码。", 401);
    }
    if (path.startsWith("/login-view/")) {
      if (!desktop) throw new SyncError("NOT_FOUND", "当前服务使用本机登录窗口。", 404);
      await desktop(request, response, path);
      return;
    }

    if (path.startsWith("/api/")) {
      if (request.headers["sec-fetch-site"] === "cross-site") throw new SyncError("FORBIDDEN", "不允许跨站访问本地服务。", 403);
      if (path === "/api/sources" && method === "GET") {
        json(response, 200, { sources: options.manager.connections() });
        return;
      }
      const match = /^\/api\/sources\/([^/]+)\/(bind|binding|sync)$/.exec(path);
      if (!match || !(SYNC_SOURCES as readonly string[]).includes(match[1])) throw new SyncError("NOT_FOUND", "接口不存在。", 404);
      const [, rawSource, action] = match;
      if ((action === "binding" && method !== "DELETE") || (action !== "binding" && method !== "POST")) {
        throw new SyncError("METHOD_NOT_ALLOWED", "不支持该请求方法。", 405);
      }
      if (request.headers["x-machun-request"] !== "1") throw new SyncError("FORBIDDEN", "缺少本地请求标记。", 403);
      const input = await body(request);
      const source = rawSource as ExternalScoreSource;
      if (action === "bind") {
        if (input.token !== undefined && typeof input.token !== "string") throw new SyncError("INVALID_REQUEST", "Token 格式无效。", 400);
        const connection = await options.manager.bind(source, input.token as string | undefined);
        json(response, source === "lxns" ? 200 : 202, { connection });
      } else if (action === "binding") {
        json(response, 200, { connection: await options.manager.unbind(source) });
      } else {
        if (input.full !== undefined && (typeof input.full !== "boolean" || source !== "otogame")) {
          throw new SyncError("INVALID_REQUEST", "全量校准参数无效。", 400);
        }
        json(response, 200, input.full === undefined
          ? await options.manager.sync(source)
          : await options.manager.sync(source, { full: input.full }));
      }
      return;
    }
    if (method !== "GET" && method !== "HEAD") throw new SyncError("METHOD_NOT_ALLOWED", "不支持该请求方法。", 405);
    if (!options.distDirectory) throw new SyncError("NOT_FOUND", "请在 http://127.0.0.1:4399 打开开发页面。", 404);
    let decoded: string;
    try { decoded = decodeURIComponent(path); } catch { throw new SyncError("NOT_FOUND", "文件不存在。", 404); }
    const root = resolve(options.distDirectory);
    const file = resolve(root, `.${decoded === "/" ? "/index.html" : decoded}`);
    if (!file.startsWith(`${root}${sep}`) || decoded.split("/").some((part) => part.startsWith("."))) {
      throw new SyncError("NOT_FOUND", "文件不存在。", 404);
    }
    let data: Buffer;
    try {
      if (!(await stat(file)).isFile()) throw new Error("not file");
      data = await readFile(file);
    } catch { throw new SyncError("NOT_FOUND", "页面尚未构建或文件不存在，请运行 pnpm build。", 404); }
    response.writeHead(200, {
      "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
      "Content-Length": data.length,
      "Cache-Control": extname(file) === ".html" ? "no-store" : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "frame-ancestors 'none'",
    });
    response.end(method === "HEAD" ? undefined : data);
  }
  return server;
}
