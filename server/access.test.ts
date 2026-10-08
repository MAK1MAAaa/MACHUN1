import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createAccessGate } from "./access";

const request = (headers: Record<string, string> = {}) => ({ headers }) as IncomingMessage;
const password = "fixture-access-password";
const authorization = `Basic ${Buffer.from(`machun:${password}`).toString("base64")}`;
afterEach(() => vi.restoreAllMocks());
describe("deployment access gate", () => {
  it("retains unauthenticated localhost mode when no password is configured", () => {
    expect(createAccessGate()(request())).toBe(true);
  });
  it("requires the deployment account and rejects forged cookies", () => {
    const gate = createAccessGate(password);
    expect(gate(request())).toBe(false);
    expect(gate(request({ authorization: `Basic ${Buffer.from(`other:${password}`).toString("base64")}` }))).toBe(false);
    expect(gate(request({ authorization: "Bearer secret" }))).toBe(false);
    expect(gate(request({ cookie: "machun_session=forged" }))).toBe(false);
    expect(gate(request({ authorization }))).toBe(true);
  });
  it("uses a same-site HTTP-only session for the WebSocket and expires it", () => {
    const gate = createAccessGate(password, true);
    const setHeader = vi.fn();
    expect(gate(request({ authorization }), { setHeader } as unknown as ServerResponse)).toBe(true);
    const cookie = setHeader.mock.calls[0][1] as string;
    expect(cookie).toContain("HttpOnly; SameSite=Strict");
    expect(cookie).toContain("; Secure");
    expect(cookie).not.toContain(password);
    expect(gate(request({ cookie }))).toBe(true);
    expect(createAccessGate(password)(request({ cookie }))).toBe(false);
    const later = Date.now() + 8 * 60 * 60 * 1000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    expect(gate(request({ cookie }))).toBe(false);
  });
});
