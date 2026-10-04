import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { SYNC_SOURCES } from "../src/syncTypes";
import type { ExternalScoreSource } from "../src/core/sources";
import type { SourceManager } from "./manager";
import { safeError } from "./manager";
import { SyncError } from "./provider";

export type HttpManager = Pick<SourceManager, "connections" | "bind" | "unbind" | "sync">;

interface HttpOptions {
  manager: HttpManager;
  distDirectory?: string;
  additionalOrigins?: string[];
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
    if (!allowedHosts.has(request.headers.host ?? "")) throw new SyncError("FORBIDDEN", "不允许的访问地址。", 403);
    const allowedOrigins = new Set([...allowedHosts].map((host) => `http://${host}`).concat(options.additionalOrigins ?? []));
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin)) throw new SyncError("FORBIDDEN", "不允许跨站访问本地服务。", 403);
    const path = new URL(request.url ?? "/", `http://127.0.0.1:${port}`).pathname;
    const method = request.method ?? "GET";

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
