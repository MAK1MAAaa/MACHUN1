import type { SourceIdentity } from "../../src/syncTypes";
import { requireIdentity, SyncError, type BrowserProvider, type BrowserSession } from "../provider";
import { identifier, isObject, requestJson, safeMusicDetails } from "./browserHttp";

const PORTAL = "https://portal.naominet.live";
const OK = 92001;

interface RinAccount extends Record<string, unknown> {
  accessToken: string;
  tokenType: string;
  refreshToken?: string;
}

function readAccount(raw: string | null): RinAccount {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (isObject(value) && typeof value.accessToken === "string" && value.accessToken &&
        typeof value.tokenType === "string" && /^[A-Za-z][A-Za-z0-9_-]*$/.test(value.tokenType) &&
        (value.refreshToken === undefined || typeof value.refreshToken === "string")) return value as RinAccount;
  } catch { /* Invalid or missing browser state requires a fresh login. */ }
  throw new SyncError("AUTH_REQUIRED", "Rin 登录状态无效，请重新网页登录。", 401);
}

function statusCode(payload: unknown): unknown {
  return isObject(payload) && isObject(payload.status) ? payload.status.code : undefined;
}

async function createClient(session: BrowserSession) {
  if (new URL(session.page.url()).origin !== PORTAL) throw new SyncError("AUTH_REQUIRED", "请先在 Rin 门户完成登录。", 401);
  let account = readAccount(await session.page.evaluate(() => localStorage.getItem("currentAccount")));
  let refreshed = false;
  const headers = () => ({ Accept: "application/json", Authorization: `${account.tokenType} ${account.accessToken}` });

  async function refresh(): Promise<void> {
    if (refreshed || !account.refreshToken) throw new SyncError("AUTH_REQUIRED", "Rin 登录已过期，请重新网页登录。", 401);
    refreshed = true;
    const result = await requestJson(session, `${PORTAL}/api/auth/refresh`, {
      method: "POST", data: { refreshToken: account.refreshToken }, headers: { Accept: "application/json" },
    });
    const payload = result.payload;
    if (result.status === 401 || result.status === 403 || statusCode(payload) !== OK || !isObject(payload) ||
        !isObject(payload.data) || typeof payload.data.accessToken !== "string" || !payload.data.accessToken) {
      throw new SyncError("AUTH_REQUIRED", "Rin 登录已过期，请重新网页登录。", 401);
    }
    const updated = { ...account, accessToken: payload.data.accessToken };
    const saved = await session.page.evaluate(({ previous, updated }) => {
      try {
        const current = JSON.parse(localStorage.getItem("currentAccount") ?? "null");
        if (!current || current.accessToken !== previous.accessToken || current.refreshToken !== previous.refreshToken) return false;
        localStorage.setItem("currentAccount", JSON.stringify(updated));
        return true;
      } catch { return false; }
    }, { previous: account, updated });
    if (!saved) throw new SyncError("IDENTITY_CHANGED", "Rin 登录状态已变化，请重新绑定。", 409);
    account = updated;
  }

  async function request(path: string): Promise<unknown> {
    const send = () => requestJson(session, `${PORTAL}${path}`, { headers: headers() });
    let result = await send();
    if (result.status === 401 || statusCode(result.payload) === 94011) {
      await refresh();
      result = await send();
    }
    if (result.status === 401 || result.status === 403 || statusCode(result.payload) === 94011) {
      throw new SyncError("AUTH_REQUIRED", "Rin 登录已过期或无权读取成绩，请重新网页登录。", 401);
    }
    return result.payload;
  }

  async function identify(pinnedCardId?: string): Promise<SourceIdentity> {
    const payload = await request("/api/user/me");
    if (statusCode(payload) !== OK || !isObject(payload) || !isObject(payload.data)) {
      throw new SyncError("UPSTREAM_FORMAT", "Rin 未返回有效的当前账号信息。");
    }
    const user = payload.data;
    const id = identifier(user.id);
    if (id === null || typeof user.username !== "string" || !user.username.trim() || !Array.isArray(user.cards) ||
        user.cards.some((card) => !isObject(card) || identifier(card.extId) === null)) {
      throw new SyncError("UPSTREAM_FORMAT", "Rin 返回的账号或卡片信息异常。");
    }
    const cards = user.cards as Array<Record<string, unknown>>;
    const matches = cards.filter((card) => pinnedCardId ? identifier(card.extId) === pinnedCardId : card.default === true);
    if (matches.length !== 1) {
      throw new SyncError(pinnedCardId ? "IDENTITY_CHANGED" : "CARD_REQUIRED",
        pinnedCardId ? "原绑定卡已不属于当前 Rin 账号，请重新绑定。" : "请在 Rin 门户设置唯一默认卡后重新绑定。", 409);
    }
    const cardId = identifier(matches[0].extId)!;
    return { id, label: `${user.username} · 卡尾号 ${cardId.slice(-4)}`, cardId };
  }
  return { identify, request, currentToken: () => account.accessToken };
}

export const rinProvider: BrowserProvider = {
  source: "rin",
  loginUrl: `${PORTAL}/`,
  async identify(session) {
    return (await createClient(session)).identify();
  },
  async fetchScores(session, expected) {
    if (!expected.cardId) throw new SyncError("CARD_REQUIRED", "Rin 绑定缺少卡片信息，请重新绑定。", 409);
    const client = await createClient(session);
    requireIdentity(await client.identify(expected.cardId), expected);
    const verifiedToken = client.currentToken();
    const payload = await client.request(`/api/game/chuni/v2/export?${new URLSearchParams({ aimeId: expected.cardId })}`);
    if (client.currentToken() !== verifiedToken) {
      requireIdentity(await client.identify(expected.cardId), expected);
    }
    return safeMusicDetails(payload, false);
  },
};
