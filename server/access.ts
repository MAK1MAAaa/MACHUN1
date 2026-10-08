import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const COOKIE = "machun_session";
const TTL = 8 * 60 * 60 * 1000;
const digest = (value: string) => createHash("sha256").update(value).digest();

/** One deployment account; the short-lived cookie also authenticates the noVNC WebSocket. */
export function createAccessGate(password?: string, secure = false) {
  const sessions = new Map<string, number>();
  const expected = password ? digest(`Basic ${Buffer.from(`machun:${password}`).toString("base64")}`) : undefined;
  return (request: IncomingMessage, response?: ServerResponse): boolean => {
    if (!expected) return true;
    const now = Date.now();
    for (const [token, expiry] of sessions) if (expiry <= now) sessions.delete(token);
    const token = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (token && (sessions.get(token) ?? 0) > now) return true;
    if (!timingSafeEqual(digest(request.headers.authorization ?? ""), expected)) return false;
    if (response) {
      if (sessions.size >= 256) sessions.delete(sessions.keys().next().value!);
      const next = randomBytes(32).toString("hex");
      sessions.set(next, now + TTL);
      response.setHeader("Set-Cookie", `${COOKIE}=${next}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${TTL / 1000}${secure ? "; Secure" : ""}`);
    }
    return true;
  };
}
