import type { BrowserSession } from "../provider";
import { SyncError } from "../provider";

export const REQUEST_TIMEOUT = 15_000;

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function identifier(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

export async function requestJson(
  session: BrowserSession,
  url: string,
  options: { method?: "GET" | "POST"; headers?: Record<string, string>; data?: unknown } = {},
): Promise<{ status: number; payload: unknown }> {
  try {
    const response = await session.context.request.fetch(url, {
      ...options,
      timeout: REQUEST_TIMEOUT,
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    try {
      const status = response.status();
      if (status >= 300 && status < 400) {
        throw new SyncError("REDIRECT_REJECTED", "服务器返回了重定向，已停止同步，请重新登录。", 502);
      }
      if (status === 401 || status === 403) return { status, payload: null };
      if (!response.ok()) throw new SyncError("UPSTREAM_ERROR", `成绩服务器请求失败（HTTP ${status}）。`);
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new SyncError("UPSTREAM_FORMAT", "成绩服务器返回的内容不是有效 JSON。");
      }
      return { status, payload };
    } finally {
      await response.dispose();
    }
  } catch (error) {
    if (error instanceof SyncError) throw error;
    // Playwright errors include request URLs and headers; never expose their text.
    throw new SyncError("UPSTREAM_UNAVAILABLE", "无法连接成绩服务器，请稍后重试。");
  }
}

export function safeMusicDetails(payload: unknown, checkGameId: boolean): {
  userMusicDetailList: Array<{ musicId: string | number; level: number; scoreMax: number }>;
} {
  if (!isObject(payload) || (checkGameId && payload.gameId !== undefined && payload.gameId !== "SDHD") ||
      !Array.isArray(payload.userMusicDetailList)) {
    throw new SyncError("UPSTREAM_FORMAT", "服务器返回的 CHUNITHM 成绩存档格式异常。");
  }
  const userMusicDetailList = payload.userMusicDetailList.map((entry) => {
    if (!isObject(entry) || identifier(entry.musicId) === null ||
        !Number.isInteger(entry.level) || Number(entry.level) < 0 || Number(entry.level) > 5 ||
        !Number.isInteger(entry.scoreMax) || Number(entry.scoreMax) < 0 || Number(entry.scoreMax) > 1_010_000) {
      throw new SyncError("UPSTREAM_FORMAT", "服务器返回的谱面成绩字段异常。");
    }
    return { musicId: entry.musicId as string | number, level: entry.level as number, scoreMax: entry.scoreMax as number };
  });
  return { userMusicDetailList };
}
