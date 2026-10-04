import type { ExternalScoreSource } from "./sources";
import type { SourceConnection, SyncOptions, SyncResult } from "../syncTypes";

export const LOCAL_SERVICE_MESSAGE = "无法连接本地同步服务，请在项目目录运行 pnpm start。文件导入仍可使用。";

export class SyncClientError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "SyncClientError";
  }
}

export function createSyncClient(fetcher: typeof fetch = fetch) {
  async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(`/api/sources${path}`, {
        method,
        headers: method === "GET"
          ? { Accept: "application/json" }
          : { Accept: "application/json", "Content-Type": "application/json", "X-Machun-Request": "1" },
        ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
      });
    } catch {
      throw new SyncClientError("service_unavailable", LOCAL_SERVICE_MESSAGE);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new SyncClientError("invalid_response", LOCAL_SERVICE_MESSAGE);
    }
    if (!response.ok) {
      const failure = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      throw new SyncClientError(
        typeof failure.code === "string" ? failure.code : "request_failed",
        typeof failure.error === "string" ? failure.error : `本地同步请求失败（HTTP ${response.status}）`,
      );
    }
    return payload as T;
  }

  return {
    async list(): Promise<SourceConnection[]> {
      const payload = await request<{ sources: SourceConnection[] }>("");
      if (!payload || !Array.isArray(payload.sources)) {
        throw new SyncClientError("invalid_response", LOCAL_SERVICE_MESSAGE);
      }
      return payload.sources;
    },
    async bind(source: ExternalScoreSource, token?: string): Promise<SourceConnection> {
      const body = source === "lxns" ? { token: token?.trim() ?? "" } : {};
      if (source === "lxns" && !body.token) throw new SyncClientError("token_required", "请输入落雪个人 API Token");
      return (await request<{ connection: SourceConnection }>(`/${source}/bind`, "POST", body)).connection;
    },
    sync(source: ExternalScoreSource, options?: SyncOptions): Promise<SyncResult> {
      return request<SyncResult>(`/${source}/sync`, "POST", options);
    },
    async unbind(source: ExternalScoreSource): Promise<SourceConnection> {
      return (await request<{ connection: SourceConnection }>(`/${source}/binding`, "DELETE")).connection;
    },
  };
}

export type SyncClient = ReturnType<typeof createSyncClient>;
