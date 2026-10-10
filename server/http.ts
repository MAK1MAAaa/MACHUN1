import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { isIP } from "node:net";
import { SYNC_SOURCES } from "../src/syncTypes";
import type { ExternalScoreSource } from "../src/core/sources";
import type { SourceManager } from "./manager";
import { safeError } from "./manager";
import { SyncError } from "./provider";
import type { AccountBackend } from "./accountService";
import { readSessionCookie, sessionCookie } from "./auth";
import { mergeOptions } from "./workspace";
import type { BrowserSource } from '../src/syncTypes';

export type HttpManager = Pick<SourceManager, "connections" | "bind" | "unbind" | "sync">;

export interface HttpOptions {
  manager?: HttpManager;
  accounts?: AccountBackend;
  distDirectory?: string;
  additionalOrigins?: string[];
  publicOrigin?: string;
  publicIpAccess?: boolean;
}

// Direct IP deployment accepts literal IPs on the application port, never DNS
// names or forwarded headers. Writes must still come from the same HTTP origin.
function directIpHost(host: string, port: number): boolean {
  try {
    const url = new URL(`http://${host}`);
    const ip = url.hostname.replace(/^\[|\]$/g, '');
    return url.host === host && url.port === String(port) && isIP(ip) !== 0
      && ip !== '0.0.0.0' && ip !== '::';
  } catch { return false; }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(body));
}

async function body(request: IncomingMessage, limit = 16 * 1024): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new SyncError("INVALID_REQUEST", "请求必须使用 JSON。", 415);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > limit) throw new SyncError("INVALID_REQUEST", "请求内容过大。", 413);
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
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (response.headersSent) { response.destroy(); return; }
      const safe = safeError(error);
      json(response, safe.status, { code: safe.code, error: safe.message });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (options.publicOrigin) allowedHosts.add(new URL(options.publicOrigin).host);
    const host = request.headers.host ?? "";
    const directIp = options.publicIpAccess && directIpHost(host, port);
    if (!allowedHosts.has(host) && !directIp) throw new SyncError("FORBIDDEN", "不允许的访问地址。", 403);
    const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...(options.additionalOrigins ?? [])]);
    if (options.publicOrigin) allowedOrigins.add(options.publicOrigin);
    if (directIp) allowedOrigins.add(`http://${host}`);
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin)) throw new SyncError("FORBIDDEN", "不允许跨站访问本地服务。", 403);
    const path = new URL(request.url ?? "/", `http://127.0.0.1:${port}`).pathname;
    const method = request.method ?? "GET";
    if (path === '/healthz' && method === 'GET') { json(response, 200, { status: 'ok' }); return; }

    if (path.startsWith("/api/")) {
      if (request.headers["sec-fetch-site"] === "cross-site") throw new SyncError("FORBIDDEN", "不允许跨站访问本地服务。", 403);
      const accounts = options.accounts;
      const token = readSessionCookie(request.headers.cookie);
      const write = () => {
        if (request.headers["x-machun-request"] !== "1") throw new SyncError("FORBIDDEN", "缺少本地请求标记。", 403);
      };
      const companion = /^\/api\/companion\/binding-tasks\/([a-f0-9-]{36})$/.exec(path);
      if (companion) {
        if (!accounts?.bindingTasks) throw new SyncError('NOT_FOUND', '登录助手未配置。', 404);
        const code = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
        if (method === 'GET') json(response, 200, await accounts.bindingTasks.companion(companion[1], code));
        else if (method === 'POST') { write(); json(response, 202, await accounts.bindingTasks.submit(companion[1], code, await body(request, 192 * 1024))); }
        else throw new SyncError('METHOD_NOT_ALLOWED', '不支持该请求方法。', 405);
        return;
      }
      if (path.startsWith("/api/auth/")) {
        if (!accounts) throw new SyncError("DATABASE_UNAVAILABLE", "账号服务尚未配置。", 503);
        if (path === "/api/auth/session" && method === "GET") {
          json(response, 200, { user: await accounts.auth.account(token) }); return;
        }
        if (path === "/api/auth/login" && method === "POST") {
          write();
          const login = await accounts.auth.login(await body(request), request.socket.remoteAddress ?? "local");
          response.setHeader("Set-Cookie", sessionCookie(login.token, false, options.publicOrigin?.startsWith('https://')));
          json(response, 200, { user: login.user }); return;
        }
        if (path === "/api/auth/logout" && method === "POST") {
          write(); await body(request);
          const user = await accounts.auth.account(token);
          await accounts.auth.logout(token);
          if (user && token) await accounts.bindingTasks?.cancelFor(user.username, undefined, token);
          response.setHeader("Set-Cookie", sessionCookie("", true, options.publicOrigin?.startsWith('https://')));
          json(response, 200, { user: null }); return;
        }
        throw new SyncError("NOT_FOUND", "接口不存在。", 404);
      }
      const user = accounts ? await accounts.auth.account(token) : null;
      if (accounts && !user) throw new SyncError("UNAUTHORIZED", "请先登录。", 401);
      if (accounts && user) {
        const task = /^\/api\/source-binding-tasks\/([a-f0-9-]{36})$/.exec(path);
        const createTask = /^\/api\/sources\/(rin|munet|otogame)\/binding-tasks$/.exec(path);
        if (task || createTask) {
          if (!accounts.bindingTasks) throw new SyncError('NOT_FOUND', '登录助手未配置。', 404);
          if (createTask && method === 'POST') { write(); await body(request); json(response, 201, await accounts.bindingTasks.create(user.username, createTask[1] as BrowserSource, token!)); }
          else if (task && method === 'GET') json(response, 200, await accounts.bindingTasks.get(user.username, task[1]));
          else if (task && method === 'DELETE') { write(); await body(request); json(response, 200, await accounts.bindingTasks.cancel(user.username, task[1])); }
          else throw new SyncError('METHOD_NOT_ALLOWED', '不支持该请求方法。', 405);
          return;
        }
        // Install the database catalogue before recalculating any user's workspace.
        await accounts.catalog();
        if (path === "/api/catalog" && method === "GET") { json(response, 200, await accounts.catalog()); return; }
        if (path === "/api/workspace" && method === "GET") { json(response, 200, await accounts.workspace.get(user.username)); return; }
        if ((path === "/api/workspace/actions" || path === "/api/workspace/migrate") && method === "POST") {
          write(); const input = await body(request, 22 * 1024 * 1024);
          json(response, 200, path.endsWith("/migrate") ? await accounts.workspace.migrate(user.username, input) : await accounts.workspace.action(user.username, input)); return;
        }
      }
      const manager = accounts && user ? await accounts.manager(user.username) : options.manager;
      if (!manager) throw new SyncError("DATABASE_UNAVAILABLE", "账号服务尚未配置。", 503);
      if (path === "/api/sources" && method === "GET") {
        json(response, 200, { sources: manager.connections() }); return;
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
        const connection = await manager.bind(source, input.token as string | undefined);
        json(response, source === "lxns" ? 200 : 202, { connection });
      } else if (action === "binding") {
        if (accounts && user && source !== 'lxns') await accounts.bindingTasks?.cancelFor(user.username, source);
        json(response, 200, { connection: await manager.unbind(source) });
      } else {
        if (input.full !== undefined && (typeof input.full !== "boolean" || source !== "otogame")) {
          throw new SyncError("INVALID_REQUEST", "全量校准参数无效。", 400);
        }
        const optionsForMerge = mergeOptions(input.mergeOptions, source);
        const result = input.full === undefined ? await manager.sync(source) : await manager.sync(source, { full: input.full });
        if (accounts && user) {
          const workspace = await accounts.workspace.mergeSync(user.username, result, optionsForMerge);
          json(response, 200, { ...result, report: workspace.report ?? result.report, workspace });
        } else json(response, 200, result);
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
