import type { Page } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { advancePortalLogin, isPortalLoginPage } from "./portalLogin";

function candidate(count = 1) {
  const handle = { click: vi.fn().mockResolvedValue(undefined), dispose: vi.fn().mockResolvedValue(undefined) };
  return {
    count: vi.fn().mockResolvedValue(count), isVisible: vi.fn().mockResolvedValue(true),
    isEnabled: vi.fn().mockResolvedValue(true), elementHandle: vi.fn().mockResolvedValue(handle), handle,
  };
}

function fakePage(url: string) {
  const state = { url };
  const bcn = candidate();
  const entry = candidate();
  const page = {
    url: () => state.url,
    goto: vi.fn(async (next: string) => { state.url = next; }),
    getByRole: vi.fn(() => bcn),
    locator: vi.fn(() => entry),
  };
  return { state, page: page as unknown as Page, mock: page, bcn, entry };
}

describe("official portal login entry", () => {
  it("matches only the verified HTTPS portal origins and paths", () => {
    for (const url of [
      "https://portal.naominet.live/", "https://portal.naominet.live/sign-in?next=home",
      "https://u.otogame.net/auth/login",
    ]) expect(isPortalLoginPage(url)).toBe(true);
    for (const url of [
      "http://portal.naominet.live/sign-in", "https://portal.naominet.live.attacker.invalid/sign-in",
      "https://portal.naominet.live:8443/sign-in", "https://x@portal.naominet.live/sign-in",
      "https://portal.naominet.live/sign-up", "https://u.otogame.net/auth/callback",
      "https://bemanicn.com/login", "https://bemanicn.com/oauth/authorize", "invalid",
    ]) expect(isPortalLoginPage(url)).toBe(false);
  });

  it("navigates Rin home once and uses the exact official BCN button", async () => {
    const fake = fakePage("https://portal.naominet.live/");
    const steps = new Set<string>();
    expect(await advancePortalLogin(fake.page, steps)).toBe("pending");
    expect(fake.mock.goto).toHaveBeenCalledExactlyOnceWith("https://portal.naominet.live/sign-in", { waitUntil: "domcontentloaded", timeout: 15_000 });
    expect(await advancePortalLogin(fake.page, steps)).toBe("manual");
    expect(fake.mock.getByRole).toHaveBeenCalledWith("button", { name: /^(使用 BEMANICN 继续|Continue with BEMANICN)$/ });
    expect(fake.bcn.handle.click).toHaveBeenCalledOnce();
    fake.state.url = "https://portal.naominet.live/";
    expect(await advancePortalLogin(fake.page, steps)).toBe("manual");
    expect(fake.mock.goto).toHaveBeenCalledOnce();
  });

  it("opens the Otogame modal once and then follows the official BCN entry", async () => {
    const fake = fakePage("https://u.otogame.net/auth/login");
    const steps = new Set<string>();
    fake.bcn.count.mockResolvedValue(0);
    expect(await advancePortalLogin(fake.page, steps)).toBe("pending");
    expect(await advancePortalLogin(fake.page, steps)).toBe("pending");
    expect(fake.entry.handle.click).toHaveBeenCalledOnce();
    expect(fake.mock.locator).toHaveBeenCalledWith(".result-action-area .auth-button.login");
    fake.bcn.count.mockResolvedValue(1);
    expect(await advancePortalLogin(fake.page, steps)).toBe("manual");
    expect(fake.mock.getByRole).toHaveBeenCalledWith("button", { name: "使用BCN账户登录", exact: true });
    expect(fake.bcn.handle.click).toHaveBeenCalledOnce();
    await advancePortalLogin(fake.page, steps);
    expect(fake.bcn.handle.click).toHaveBeenCalledOnce();
  });

  it("accepts an already-open Otogame login modal without clicking an unrelated entry", async () => {
    const fake = fakePage("https://u.otogame.net/auth/login");
    expect(await advancePortalLogin(fake.page, new Set())).toBe("manual");
    expect(fake.bcn.handle.click).toHaveBeenCalledOnce();
    expect(fake.entry.handle.click).not.toHaveBeenCalled();
  });

  it("does not choose between ambiguous Otogame page-body entries", async () => {
    const fake = fakePage("https://u.otogame.net/auth/login");
    fake.bcn.count.mockResolvedValue(0);
    fake.entry.count.mockResolvedValue(2);
    expect(await advancePortalLogin(fake.page, new Set())).toBe("manual");
    expect(fake.entry.handle.click).not.toHaveBeenCalled();
    expect(fake.bcn.handle.click).not.toHaveBeenCalled();
  });

  it.each(["missing", "hidden", "disabled", "ambiguous"] as const)("does not click a %s candidate", async (condition) => {
    const fake = fakePage("https://portal.naominet.live/sign-in");
    if (condition === "missing") fake.bcn.count.mockResolvedValue(0);
    if (condition === "hidden") fake.bcn.isVisible.mockResolvedValue(false);
    if (condition === "disabled") fake.bcn.isEnabled.mockResolvedValue(false);
    if (condition === "ambiguous") fake.bcn.count.mockResolvedValue(2);
    expect(await advancePortalLogin(fake.page, new Set())).toBe(condition === "ambiguous" ? "manual" : "pending");
    expect(fake.bcn.handle.click).not.toHaveBeenCalled();
  });

  it("marks a step before clicking and never retries a failed click", async () => {
    const fake = fakePage("https://portal.naominet.live/sign-in");
    const steps = new Set<string>();
    fake.bcn.handle.click.mockImplementation(async () => {
      expect(steps.size).toBe(1);
      throw new Error("synthetic browser error");
    });
    expect(await advancePortalLogin(fake.page, steps)).toBe("manual");
    expect(await advancePortalLogin(fake.page, steps)).toBe("manual");
    expect(fake.bcn.handle.click).toHaveBeenCalledOnce();
    expect(fake.bcn.handle.dispose).toHaveBeenCalledOnce();
  });

  it("shares step locks across concurrently handled login windows", async () => {
    const first = fakePage("https://portal.naominet.live/sign-in");
    const second = fakePage("https://portal.naominet.live/sign-in");
    const steps = new Set<string>();
    await Promise.all([advancePortalLogin(first.page, steps), advancePortalLogin(second.page, steps)]);
    expect(first.bcn.handle.click.mock.calls.length + second.bcn.handle.click.mock.calls.length).toBe(1);
  });

  it("does not click after navigation to a consent page or start an unknown flow", async () => {
    const fake = fakePage("https://portal.naominet.live/sign-in");
    fake.bcn.elementHandle.mockImplementation(async () => {
      fake.state.url = "https://bemanicn.com/oauth/authorize";
      return fake.bcn.handle;
    });
    expect(await advancePortalLogin(fake.page, new Set())).toBe("manual");
    expect(fake.bcn.handle.click).not.toHaveBeenCalled();
    fake.mock.getByRole.mockClear();
    expect(await advancePortalLogin(fake.page, new Set())).toBe("manual");
    expect(fake.mock.getByRole).not.toHaveBeenCalled();
    expect(fake.mock.goto).not.toHaveBeenCalled();
  });
});
