import type { Locator, Page } from "playwright";

type AdvanceResult = "pending" | "manual";
type ClickResult = "clicked" | "pending" | "manual";
interface PortalPage { portal: "rin" | "otogame"; origin: string; pathname: string }

const RIN_ORIGIN = "https://portal.naominet.live";
const OTOGAME_ORIGIN = "https://u.otogame.net";
const RIN_OPEN = "portal:rin:open-sign-in";
const RIN_BCN = "portal:rin:continue-bcn";
const OTOGAME_OPEN = "portal:otogame:open-login";
const OTOGAME_BCN = "portal:otogame:continue-bcn";

function portalPage(raw: string): PortalPage | undefined {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return;
    if (url.origin === RIN_ORIGIN && (url.pathname === "/" || url.pathname === "/sign-in")) {
      return { portal: "rin", origin: url.origin, pathname: url.pathname };
    }
    if (url.origin === OTOGAME_ORIGIN && url.pathname === "/auth/login") {
      return { portal: "otogame", origin: url.origin, pathname: url.pathname };
    }
  } catch { /* An unrecognized URL always stays under manual control. */ }
}

export function isPortalLoginPage(url: string): boolean {
  return Boolean(portalPage(url));
}

function stillOnPage(page: Page, expected: PortalPage): boolean {
  const current = portalPage(page.url());
  return current?.origin === expected.origin && current.pathname === expected.pathname;
}

async function clickOnce(page: Page, expected: PortalPage, candidate: Locator, steps: Set<string>, step: string): Promise<ClickResult> {
  if (steps.has(step)) return "manual";
  try {
    const count = await candidate.count();
    if (count === 0) return "pending";
    if (count !== 1) return "manual";
    if (!await candidate.isVisible() || !await candidate.isEnabled()) return "pending";
    // Keep the original document's element rather than resolving a locator after a redirect.
    const element = await candidate.elementHandle();
    if (!element) return "pending";
    try {
      if (!stillOnPage(page, expected) || steps.has(step)) return "manual";
      // Shared across all pages in a binding context, including concurrent popups.
      steps.add(step);
      await element.click({ timeout: 3_000 });
      return "clicked";
    } finally {
      await element.dispose().catch(() => undefined);
    }
  } catch {
    // Once a click was attempted, leave retries to the user instead of looping the SSO flow.
    return steps.has(step) ? "manual" : "pending";
  }
}

/** Advance only the official portal entry controls. Passwords and OAuth consent are out of scope. */
export async function advancePortalLogin(page: Page, steps: Set<string>): Promise<AdvanceResult> {
  const current = portalPage(page.url());
  if (!current) return "manual";
  if (current.portal === "rin") {
    if (steps.has(RIN_BCN)) return "manual";
    if (current.pathname === "/") {
      if (steps.has(RIN_OPEN)) return "manual";
      steps.add(RIN_OPEN);
      try {
        await page.goto(`${RIN_ORIGIN}/sign-in`, { waitUntil: "domcontentloaded", timeout: 15_000 });
        return "pending";
      } catch { return "manual"; }
    }
    const result = await clickOnce(page, current, page.getByRole("button", {
      name: /^(使用 BEMANICN 继续|Continue with BEMANICN)$/,
    }), steps, RIN_BCN);
    return result === "pending" ? "pending" : "manual";
  }

  if (steps.has(OTOGAME_BCN)) return "manual";
  const bcnButton = page.getByRole("button", { name: "使用BCN账户登录", exact: true });
  try {
    // A modal or popup may already be open before the watcher attaches.
    const result = await clickOnce(page, current, bcnButton, steps, OTOGAME_BCN);
    if (result !== "pending") return "manual";
    if (steps.has(OTOGAME_OPEN)) return "pending";
    // The header repeats the same login control; use the verified page-body action area.
    const opened = await clickOnce(page, current, page.locator(".result-action-area .auth-button.login"), steps, OTOGAME_OPEN);
    return opened === "manual" ? "manual" : "pending";
  } catch { return "pending"; }
}
