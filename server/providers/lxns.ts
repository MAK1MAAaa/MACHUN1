import { SyncError, requireIdentity } from "../provider";
import type { SourceIdentity } from "../../src/syncTypes";
import { readScoreAchievements } from "../../src/core/scoreAchievements";

const BASE = "https://maimai.lxns.net/api/v0/user/chunithm/player";

export class LxnsProvider {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  private async request(token: string, suffix = ""): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`${BASE}${suffix}`, {
        headers: { Accept: "application/json", "X-User-Token": token },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new SyncError("NETWORK_ERROR", "落雪连接失败或超时，请稍后重试。");
    }
    if (response.status === 401 || response.status === 403) {
      throw new SyncError("AUTH_REQUIRED", "落雪 Token 已失效或无权读取成绩，请重新绑定。", 401);
    }
    if (!response.ok) throw new SyncError("UPSTREAM_ERROR", `落雪暂时不可用（HTTP ${response.status}）。`);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new SyncError("INVALID_RESPONSE", "落雪返回的数据格式无效。"); }
    if (!payload || typeof payload !== "object" || !("data" in payload) || (payload as { success?: boolean }).success === false) {
      throw new SyncError("INVALID_RESPONSE", "落雪接口未返回有效数据，请检查 Token 或稍后重试。");
    }
    return (payload as { data: unknown }).data;
  }

  async identify(token: string): Promise<SourceIdentity> {
    const data = await this.request(token);
    if (!data || typeof data !== "object" || Array.isArray(data) || !("friend_code" in data) ||
      !(typeof data.friend_code === "number" && Number.isSafeInteger(data.friend_code) && data.friend_code > 0
        || typeof data.friend_code === "string" && /^[1-9]\d*$/.test(data.friend_code))) {
      throw new SyncError("INVALID_RESPONSE", "落雪账号尚未绑定中二节奏玩家，或玩家数据格式发生变化。");
    }
    const name = "name" in data && typeof data.name === "string" ? data.name : "落雪玩家";
    return { id: String(data.friend_code), label: name.slice(0, 120) };
  }

  async fetchScores(token: string, identity: SourceIdentity): Promise<unknown> {
    requireIdentity(await this.identify(token), identity);
    const data = await this.request(token, "/scores");
    if (!Array.isArray(data)) throw new SyncError("INVALID_RESPONSE", "落雪成绩列表格式发生变化。");
    return data.map((entry: unknown) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new SyncError("INVALID_RESPONSE", "落雪成绩列表包含无效记录。");
      const record = entry as Record<string, unknown>;
      if (!(typeof record.id === "number" && Number.isSafeInteger(record.id) && record.id >= 0
          || typeof record.id === "string" && /^\d+$/.test(record.id))
        || typeof record.level_index !== "number" || !Number.isInteger(record.level_index) || record.level_index < 0 || record.level_index > 5
        || typeof record.score !== "number" || !Number.isInteger(record.score) || record.score < 0 || record.score > 1_010_000) {
        throw new SyncError("INVALID_RESPONSE", "落雪成绩列表字段发生变化，本次未更新成绩。");
      }
      return {
        id: record.id, level_index: record.level_index, score: record.score,
        play_time: record.play_time, upload_time: record.upload_time,
        ...readScoreAchievements(record, record.score),
      };
    });
  }
}
