import { setTimeout as delay } from "node:timers/promises";
import type { BrowserContext, Locator, Page } from "playwright";
import type { BrowserSource } from "../src/syncTypes";
import { approveBcnConsent, isBcnConsentPage } from "./bcnConsent";
import type { LoginCredentials } from "./config";

interface LoginRule {
  origin: string;
  pathname: string;
  usernameSelector: string;
  passwordSelector: string;
  requiresForm: boolean;
}

const RIN_ORIGIN = "https://portal.naominet.live";
const OTO_ORIGIN = "https://u.otogame.net";
const BCN: LoginRule = {
  origin: "https://bemanicn.com", pathname: "/login",
  usernameSelector: "input#email[type=email]", passwordSelector: "input#password[type=password]",
  requiresForm: true,
};
const MUNET: LoginRule = {
  origin: "https://portal.mumur.net", pathname: "/login",
  usernameSelector: 'input[placeholder="用户名"]:not([type=password])', passwordSelector: 'input[type=password][placeholder="密码"]',
  requiresForm: false,
};

function matchesPage(page: Page, origin: string, pathname: string): boolean {
  try {
    const url = new URL(page.url());
    return !url.username && !url.password && url.origin === origin && url.pathname === pathname;
  } catch {
    return false;
  }
}

type EntryStep = "rin-sign-in" | "oto-open-login" | "continue-bcn";
type EntryResult = "unavailable" | "attempted" | "manual";

async function clickEntry(page: Page, origin: string, pathname: string, candidate: Locator,
  steps: Set<EntryStep>, step: EntryStep, signal: AbortSignal): Promise<EntryResult> {
  if (steps.has(step)) return "attempted";
  const count = await candidate.count();
  if (count > 1) return "manual";
  if (count !== 1 || !await candidate.isVisible() || !await candidate.isEnabled()) return "unavailable";
  const element = await candidate.elementHandle({ timeout: 1_000 });
  if (!element) return "unavailable";
  try {
    if (signal.aborted || !matchesPage(page, origin, pathname)) return "manual";
    steps.add(step);
    await element.click({ timeout: 1_000 });
    return "attempted";
  } finally {
    await element.dispose().catch(() => undefined);
  }
}

async function advanceEntry(page: Page, source: BrowserSource, steps: Set<EntryStep>, signal: AbortSignal) {
  if (source === "rin" && !steps.has("continue-bcn")) {
    if (matchesPage(page, RIN_ORIGIN, "/") && !steps.has("rin-sign-in")) {
      steps.add("rin-sign-in");
      await page.goto(`${RIN_ORIGIN}/sign-in`, { waitUntil: "domcontentloaded", timeout: 5_000 });
    } else if (matchesPage(page, RIN_ORIGIN, "/sign-in")) {
      await clickEntry(page, RIN_ORIGIN, "/sign-in", page.getByRole("button", {
        name: /^(使用 BEMANICN 继续|Continue with BEMANICN)$/,
      }), steps, "continue-bcn", signal);
    }
  } else if (source === "otogame" && matchesPage(page, OTO_ORIGIN, "/auth/login") && !steps.has("continue-bcn")) {
    const result = await clickEntry(page, OTO_ORIGIN, "/auth/login",
      page.getByRole("button", { name: "使用BCN账户登录", exact: true }), steps, "continue-bcn", signal);
    if (result === "unavailable") {
      await clickEntry(page, OTO_ORIGIN, "/auth/login",
        page.locator(".result-action-area .auth-button.login"), steps, "oto-open-login", signal);
    }
  }
}

async function tryLogin(page: Page, rule: LoginRule, credentials: LoginCredentials, signal: AbortSignal, claim: () => void) {
  // A handle stays bound to the inspected document. A redirect invalidates it rather
  // than resolving an input or running credential-bearing code in the next page.
  const fields = await page.evaluateHandle((expected) => {
    if (location.origin !== expected.origin || location.pathname !== expected.pathname) return null;
    const users = document.querySelectorAll<HTMLInputElement>(expected.usernameSelector);
    const passwords = document.querySelectorAll<HTMLInputElement>(expected.passwordSelector);
    const user = users[0];
    const password = passwords[0];
    if (users.length !== 1 || passwords.length !== 1 || !(user instanceof HTMLInputElement)
      || !(password instanceof HTMLInputElement)) return null;

    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setValue) return null;
    // Keep helpers in method syntax so tsx does not insert a Node-side name
    // helper into the function serialized to the browser.
    const form = {
      visible(element: HTMLElement) {
        return element.getClientRects().length > 0 && getComputedStyle(element).visibility === "visible";
      },
      validOwner(owner: HTMLFormElement | null) {
        if (password.form !== owner) return false;
        if (!owner) return !expected.requiresForm;
        const action = new URL(owner.action);
        return !action.username && !action.password && action.origin === expected.origin && action.pathname === expected.pathname
          && (owner.getAttribute("method") === null || owner.method === "post");
      },
      current() {
        return location.origin === expected.origin && location.pathname === expected.pathname
          && user.isConnected && password.isConnected && this.visible(user) && this.visible(password)
          && !user.matches(":disabled") && !password.matches(":disabled") && !user.readOnly && !password.readOnly
          && this.validOwner(user.form);
      },
      update(input: HTMLInputElement, value: string) {
        setValue.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      },
    };
    if (!form.current()) return null;
    return {
      occupied: Boolean(user.value || password.value),
      fill(saved: { username: string; password: string }) {
        if (!form.current() || user.value || password.value) return false;
        form.update(user, saved.username);
        if (!form.current() || password.value) return false;
        form.update(password, saved.password);
        return true;
      },
      submit(saved: { username: string; password: string }) {
        if (!form.current() || user.value !== saved.username || password.value !== saved.password) return "manual";
        const owner = user.form;
        const buttons = Array.from((owner ?? document).querySelectorAll<HTMLButtonElement>("button"))
          .filter(button => form.visible(button) && button.textContent?.replace(/\s/g, "") === "登录");
        if (buttons.length === 0) return "pending";
        if (buttons.length !== 1) return "manual";
        const button = buttons[0];
        if (button.form !== owner || (expected.requiresForm && button.type !== "submit")
          || button.hasAttribute("formmethod") || button.hasAttribute("formaction")) return "manual";
        if (button.matches(":disabled") || button.getAttribute("aria-disabled") === "true") return "pending";
        // The BCN JS handler submits its form. Guard the native fallback from
        // including credentials in a GET URL while the reactive app is starting.
        if (owner && owner.getAttribute("method") === null && button.type === "submit") {
          const preventGet = { handleEvent(event: Event) { event.preventDefault(); } };
          owner.addEventListener("submit", preventGet, true);
          try { button.click(); }
          finally { owner.removeEventListener("submit", preventGet, true); }
        } else {
          button.click();
        }
        return "submitted";
      },
    };
  }, rule);
  try {
    const ready = await fields.evaluate(form => form === null ? "pending" : form.occupied ? "manual" : "ready");
    if (signal.aborted || ready === "pending") return;
    claim();
    if (ready === "manual") return;
    if (!await fields.evaluate((form, saved) => form?.fill(saved), credentials)) return;

    // Wait briefly for reactive validation. Only the portal's regular login
    // button is used, leaving any challenge or authorization to the user.
    for (let attempt = 0; attempt < 25 && !signal.aborted; attempt += 1) {
      const result = await fields.evaluate((form, saved) => form?.submit(saved), credentials);
      if (result !== "pending") return;
      await delay(100, undefined, { signal });
    }
  } finally {
    await fields.dispose().catch(() => undefined);
  }
}

/** Attempt login in a dedicated visible browser opened by an explicit bind action. */
export function attachAutomaticLogin(context: BrowserContext, source: BrowserSource, credentials: LoginCredentials,
  signal: AbortSignal): () => void {
  const controller = new AbortController();
  const steps = new Set<EntryStep>();
  const rule = source === "munet" ? MUNET : BCN;
  let loginAttempted = false;
  let consentAttempted = false;
  const keepWatching = () => !controller.signal.aborted && !consentAttempted && (!loginAttempted || steps.has("continue-bcn"));
  const stop = () => {
    controller.abort();
    signal.removeEventListener("abort", stop);
    context.off("close", stop);
  };
  if (signal.aborted) return stop;
  signal.addEventListener("abort", stop, { once: true });
  context.on("close", stop);

  void (async () => {
    try {
      // A single scan handles same-page navigation and new SSO windows without
      // allowing two documents to claim the same password attempt.
      while (keepWatching()) {
        const pages = context.pages().filter(page => !page.isClosed());
        if (pages.length === 0) break;
        for (const page of pages) {
          if (!keepWatching()) break;
          try {
            if (source !== "munet" && steps.has("continue-bcn") && isBcnConsentPage(page.url(), source)) {
              await approveBcnConsent(page, source, controller.signal, () => { consentAttempted = true; });
            } else if (!loginAttempted && matchesPage(page, rule.origin, rule.pathname)) {
              await tryLogin(page, rule, credentials, controller.signal, () => { loginAttempted = true; });
            } else if (!loginAttempted) {
              await advanceEntry(page, source, steps, controller.signal);
            }
          } catch {
            // Navigation and framework changes leave the visible window usable.
            // Browser errors can include evaluated arguments, so keep them local.
          }
        }
        if (keepWatching()) await delay(300, undefined, { signal: controller.signal });
      }
    } catch {
      // The delay is interrupted when the binding is cancelled.
    } finally {
      stop();
    }
  })();
  return stop;
}
