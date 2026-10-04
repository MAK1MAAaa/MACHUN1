import type { SourceIdentity } from "../../src/syncTypes";
import { requireIdentity, SyncError, type BrowserProvider, type BrowserSession } from "../provider";
import { identifier, isObject, REQUEST_TIMEOUT, safeMusicDetails } from "./browserHttp";

const PORTAL = "https://portal.mumur.net";
const API_V3 = "https://apidashboard3-cf.mumur.net";
const API_V2 = "https://apidashboard2-cf.mumur.net";

interface MuNetState {
  token: string;
  refreshToken: string;
  environmentKey: string;
}

async function requestJson(
  session: BrowserSession,
  url: string,
  options: { method?: "GET" | "POST"; headers?: Record<string, string>; data?: unknown; v3?: boolean } = {},
): Promise<{ status: number; payload: unknown }> {
  try {
    // MuNET accepts requests from its portal browser, but rejects Playwright's
    // separate APIRequestContext transport with HTTP 418, even for public APIs.
    const result = await session.page.evaluate(async ({ url, options, portal, timeout }) => {
      if (location.origin !== portal) return { status: 0, payload: null, wrongOrigin: true };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(url, {
          method: options.method ?? "GET",
          headers: {
            ...options.headers,
            ...(options.data === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: options.data === undefined ? null : JSON.stringify(options.data),
          credentials: "same-origin",
          ...(options.v3 ? { referrerPolicy: "no-referrer" as const } : {}),
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok) return { status: response.status, payload: null };
        try {
          return { status: response.status, payload: await response.json() as unknown };
        } catch {
          return { status: response.status, payload: null, invalidJson: true };
        }
      } finally {
        clearTimeout(timer);
      }
    }, { url, options, portal: PORTAL, timeout: REQUEST_TIMEOUT });
    if (result.wrongOrigin) throw new SyncError("AUTH_REQUIRED", "请先在 MuNET 门户完成登录。", 401);
    if (result.status >= 300 && result.status < 400) {
      throw new SyncError("REDIRECT_REJECTED", "服务器返回了重定向，已停止同步，请重新登录。");
    }
    if (result.status === 401 || result.status === 403) return { status: result.status, payload: null };
    if (result.status < 200 || result.status >= 300) {
      throw new SyncError("UPSTREAM_ERROR", `成绩服务器请求失败（HTTP ${result.status}）。`);
    }
    if (result.invalidJson) throw new SyncError("UPSTREAM_FORMAT", "成绩服务器返回的内容不是有效 JSON。");
    return { status: result.status, payload: result.payload };
  } catch (error) {
    if (error instanceof SyncError) throw error;
    // Browser errors can contain the export URL and token. Keep them local.
    throw new SyncError("UPSTREAM_UNAVAILABLE", "无法连接 MuNET 成绩服务器，请稍后重试或重新网页登录。");
  }
}

function subject(token: string): string {
  try {
    const claims: unknown = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    if (isObject(claims)) {
      const id = identifier(claims.sub);
      if (id && /^\d+$/.test(id) && Number.isSafeInteger(Number(id))) return id;
    }
  } catch { /* A token is accepted only after the remote identity request succeeds. */ }
  throw new SyncError("AUTH_REQUIRED", "MuNET 登录状态无效，请重新网页登录。", 401);
}

async function createClient(session: BrowserSession) {
  if (new URL(session.page.url()).origin !== PORTAL) {
    throw new SyncError("AUTH_REQUIRED", "请先在 MuNET 门户完成登录。", 401);
  }
  const state: MuNetState = await session.page.evaluate(() => ({
    token: localStorage.getItem("token") ?? "",
    refreshToken: localStorage.getItem("refreshToken") ?? "",
    environmentKey: localStorage.getItem("environmentKey") ?? "",
  }));
  if (!state.token) throw new SyncError("AUTH_REQUIRED", "请先在 MuNET 门户完成登录。", 401);
  const initialSubject = subject(state.token);
  let refreshed = false;
  const headers = () => ({
    Accept: "application/json",
    Authorization: `Bearer ${state.token}`,
    "X-Env-Key": state.environmentKey,
  });

  async function refresh(): Promise<void> {
    if (refreshed || !state.refreshToken) throw new SyncError("AUTH_REQUIRED", "MuNET 登录已过期，请重新网页登录。", 401);
    refreshed = true;
    const result = await requestJson(session, `${API_V3}/api/v3/TokenExchange/RefreshToken`, {
      method: "POST", headers: headers(), data: { token: state.refreshToken, auId: Number(initialSubject) }, v3: true,
    });
    if (result.status === 401 || result.status === 403 || typeof result.payload !== "string" || !result.payload) {
      throw new SyncError("AUTH_REQUIRED", "MuNET 登录已过期，请重新网页登录。", 401);
    }
    const token = result.payload;
    if (subject(token) !== initialSubject) throw new SyncError("IDENTITY_CHANGED", "MuNET 登录账号已变化，请重新绑定。", 409);
    const saved = await session.page.evaluate(({ oldToken, refreshToken, token }) => {
      if (localStorage.getItem("token") !== oldToken || localStorage.getItem("refreshToken") !== refreshToken) return false;
      localStorage.setItem("token", token);
      return true;
    }, { oldToken: state.token, refreshToken: state.refreshToken, token });
    if (!saved) throw new SyncError("IDENTITY_CHANGED", "MuNET 登录状态已变化，请重试绑定。", 409);
    state.token = token;
  }

  async function request(path: "identity" | "export"): Promise<unknown> {
    const send = () => path === "identity"
      ? requestJson(session, `${API_V3}/api/v3/UserHome?locale=zh-Hans`, { headers: headers(), v3: true })
      : requestJson(session, `${API_V2}/api/v2/game/chu3/export?${new URLSearchParams({ token: state.token })}`, {
        method: "POST",
        headers: state.environmentKey ? { "X-Env-Key": state.environmentKey } : {},
      });
    let result = await send();
    if (result.status === 401) {
      await refresh();
      result = await send();
    }
    if (result.status === 401 || result.status === 403) throw new SyncError("AUTH_REQUIRED", "MuNET 登录已过期或无权读取成绩，请重新网页登录。", 401);
    return result.payload;
  }

  async function identify(): Promise<SourceIdentity> {
    const payload = await request("identity");
    if (!isObject(payload) || !isObject(payload.user) || typeof payload.user.username !== "string" || !payload.user.username.trim()) {
      throw new SyncError("UPSTREAM_FORMAT", "MuNET 未返回有效的当前账号信息。");
    }
    // UserHome authenticates this token remotely; JWT.sub supplies its stable account ID.
    return { id: subject(state.token), label: payload.user.username };
  }
  return { identify, request };
}

export const munetProvider: BrowserProvider = {
  source: "munet",
  loginUrl: `${PORTAL}/user`,
  async identify(session) {
    return (await createClient(session)).identify();
  },
  async fetchScores(session, expected) {
    const client = await createClient(session);
    requireIdentity(await client.identify(), expected);
    const payload = await client.request("export");
    return { gameId: "SDHD", ...safeMusicDetails(payload, true) };
  },
};
