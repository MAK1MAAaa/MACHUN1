import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import type { BrowserContext, JSHandle, Page } from "playwright";
import { advancePortalLogin, isPortalLoginPage } from "./portalLogin";

export type CredentialTarget = "bcn" | "munet";
interface LoginCredentials { username: string; password: string }
export type CredentialReader = (target: CredentialTarget) => Promise<LoginCredentials | null>;
type FillOutcome = "filled" | "submitted" | "manual" | "pending";

interface LoginRule {
  target: CredentialTarget;
  origin: string;
  pathname: string;
  usernameSelector: string;
  passwordSelector: string;
}

// Verified from the official login pages; never match a suffix or an arbitrary SSO redirect.
const LOGIN_RULES: readonly LoginRule[] = [
  { target: "bcn", origin: "https://bemanicn.com", pathname: "/login", usernameSelector: "input#email[type=email]", passwordSelector: "input#password[type=password]" },
  { target: "munet", origin: "https://portal.mumur.net", pathname: "/login", usernameSelector: 'input[placeholder="用户名"]:not([type=password])', passwordSelector: 'input[type=password][placeholder="密码"]' },
];

export function loginRuleForUrl(raw: string): LoginRule | undefined {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return;
    return LOGIN_RULES.find((rule) => rule.origin === url.origin && rule.pathname === url.pathname);
  } catch { return; }
}

/** Read only when a verified empty login form is ready. Do not put .env values in process.env. */
export function createCredentialReader(path: string, environment: NodeJS.ProcessEnv = process.env): CredentialReader {
  return async (target) => {
    const [usernameKey, passwordKey] = target === "bcn"
      ? ["BCN_EMAIL", "BCN_PASSWORD"] : ["MUNET_USERNAME", "MUNET_PASSWORD"];
    let file: Record<string, string | undefined> = {};
    if (environment[usernameKey] === undefined || environment[passwordKey] === undefined) {
      try { file = parseEnv(await readFile(path, "utf8")); }
      catch { return null; }
    }
    const username = (environment[usernameKey] ?? file[usernameKey] ?? "").trim();
    const password = environment[passwordKey] ?? file[passwordKey] ?? "";
    return username && password ? { username, password } : null;
  };
}

interface LoginForm {
  status: "ready" | "manual" | "pending";
  document?: Document;
  username?: HTMLInputElement;
  password?: HTMLInputElement;
  expectedUsername?: string;
  expectedPassword?: string;
  submit?: HTMLButtonElement;
}

interface SubmissionOptions {
  claim(target: CredentialTarget): boolean;
  signal?: AbortSignal;
}

function waitForFormUpdate(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, 100);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
  });
}

/** Submission is opt-in and claimed once for the entire binding session. */
export async function fillCredentialsForPage(
  page: Page,
  readCredentials: CredentialReader,
  submission?: SubmissionOptions,
): Promise<FillOutcome> {
  const rule = loginRuleForUrl(page.url());
  if (!rule || submission?.signal?.aborted) return "manual";
  let form: JSHandle<LoginForm> | undefined;
  try {
    form = await page.evaluateHandle((expected): LoginForm => {
      if (location.origin !== expected.origin || location.pathname !== expected.pathname) return { status: "manual" };
      const usernames = document.querySelectorAll(expected.usernameSelector);
      const passwords = document.querySelectorAll(expected.passwordSelector);
      if (usernames.length !== 1 || passwords.length !== 1) return { status: "pending" };
      const username = usernames[0];
      const password = passwords[0];
      if (!(username instanceof HTMLInputElement) || !(password instanceof HTMLInputElement)
        || username.disabled || username.readOnly || password.disabled || password.readOnly
        || !username.getClientRects().length || !password.getClientRects().length) return { status: "pending" };
      // If either field has user input, leave both untouched rather than mixing accounts.
      if (username.value || password.value) return { status: "manual" };
      return { status: "ready", document, username, password };
    }, rule);
    const status = await form.evaluate((value) => value.status);
    if (status !== "ready") return status;
    const credentials = await readCredentials(rule.target);
    if (!credentials || submission?.signal?.aborted) return "manual";
    // This handle belongs to the inspected document. Navigation destroys it instead of
    // evaluating credential-bearing arguments in a newly navigated, unrelated document.
    const filled = await form.evaluate((value, { expected, credentials: saved }) => {
      const { username, password } = value;
      if (value.document !== document || location.origin !== expected.origin || location.pathname !== expected.pathname
        || !username?.isConnected || !password?.isConnected || username.value || password.value
        || username.disabled || username.readOnly || password.disabled || password.readOnly) return false;
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!setValue) return false;
      setValue.call(username, saved.username);
      username.dispatchEvent(new Event("input", { bubbles: true }));
      username.dispatchEvent(new Event("change", { bubbles: true }));
      if (!password.isConnected || password.value) return false;
      setValue.call(password, saved.password);
      password.dispatchEvent(new Event("input", { bubbles: true }));
      password.dispatchEvent(new Event("change", { bubbles: true }));
      value.expectedUsername = saved.username;
      value.expectedPassword = saved.password;
      return true;
    }, { expected: rule, credentials });
    if (!filled) return "manual";
    if (!submission) return "filled";
    // Allow the portal's reactive form to enable its login button. CAPTCHA execution
    // belongs to the official handler: MuNET continues it after the user verifies.
    for (let attempt = 0; attempt < 25; attempt += 1) {
      if (submission.signal?.aborted) return "filled";
      const ready = await form.evaluate((value, expected) => {
        const { username, password } = value;
        if (value.document !== document || location.origin !== expected.origin || location.pathname !== expected.pathname
          || !username?.isConnected || !password?.isConnected
          || username.value !== value.expectedUsername || password.value !== value.expectedPassword) return "manual";
        const owner = username.form;
        if (expected.target === "bcn" && (!owner || password.form !== owner
          || (owner.getAttribute("method") !== null && owner.method.toLowerCase() !== "post")
          || new URL(owner.action).origin !== expected.origin
          || new URL(owner.action).pathname !== expected.pathname)) return "manual";
        const buttons = Array.from((owner ?? document).querySelectorAll(expected.target === "bcn" ? 'button[type="submit"]' : "button"))
          .filter((button) => button instanceof HTMLButtonElement && button.getClientRects().length
            && button.textContent?.replace(/\s/g, "") === "登录");
        if (buttons.length !== 1) return "pending";
        const button = buttons[0] as HTMLButtonElement;
        if (button.disabled || button.getAttribute("aria-disabled") === "true") return "pending";
        value.submit = button;
        return "ready";
      }, rule);
      if (ready === "manual") return "manual";
      if (ready === "ready") {
        // Claim before clicking: navigation can destroy the evaluation context after a
        // successful click, and a rejected password must never trigger another attempt.
        if (submission.signal?.aborted || !submission.claim(rule.target)) return "filled";
        const submitted = await form.evaluate((value, expected) => {
          const { username, password, submit } = value;
          if (value.document !== document || location.origin !== expected.origin || location.pathname !== expected.pathname
            || !username?.isConnected || !password?.isConnected || !submit?.isConnected
            || username.value !== value.expectedUsername || password.value !== value.expectedPassword
            || username.disabled || username.readOnly || password.disabled || password.readOnly
            || !submit.getClientRects().length || submit.disabled || submit.getAttribute("aria-disabled") === "true"
            || submit.textContent?.replace(/\s/g, "") !== "登录") return false;
          if (expected.target === "bcn") {
            const owner = username.form;
            if (!owner || password.form !== owner || submit.form !== owner
              || (owner.getAttribute("method") !== null && owner.method.toLowerCase() !== "post")
              || new URL(owner.action).origin !== expected.origin
              || new URL(owner.action).pathname !== expected.pathname) return false;
            // BCN's verified Inertia form has no method/action attributes. Its own
            // submit handler posts through JS; prevent any native GET fallback from
            // placing a password in a URL if that handler has not attached yet.
            if (owner.getAttribute("method") === null) {
              owner.addEventListener("submit", (event) => event.preventDefault(), { capture: true, once: true });
            }
          }
          submit.click();
          return true;
        }, rule);
        return submitted ? "submitted" : "manual";
      }
      await waitForFormUpdate(submission.signal);
    }
    return "filled";
  } catch {
    // Playwright errors may include evaluated arguments. Never return or log their text.
    return "pending";
  } finally {
    await form?.dispose().catch(() => undefined);
  }
}

/** Automate official login entry and one password attempt; verification/consent stays interactive. */
export function attachAutomaticLogin(context: BrowserContext, readCredentials: CredentialReader): () => void {
  const cleanups = new Map<Page, () => void>();
  const portalSteps = new Set<string>();
  const submittedTargets = new Set<CredentialTarget>();
  let stopped = false;
  const watch = (page: Page) => {
    if (stopped || cleanups.has(page)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;
    let attempts = 0;
    let running = false;
    let done = false;
    let closed = false;
    const abort = new AbortController();
    const schedule = () => {
      if (timer) clearTimeout(timer);
      if (stopped || closed || done || attempts >= 100
        || !(loginRuleForUrl(page.url()) || isPortalLoginPage(page.url()))) return;
      timer = setTimeout(() => { void run(); }, 300);
    };
    const run = async () => {
      timer = undefined;
      if (stopped || closed || done) return;
      if (running) { schedule(); return; }
      running = true;
      const current = generation;
      attempts += 1;
      let outcome: FillOutcome = "manual";
      try {
        const rule = loginRuleForUrl(page.url());
        outcome = rule
          ? submittedTargets.has(rule.target) ? "manual" : await fillCredentialsForPage(page, readCredentials, {
            signal: abort.signal,
            claim: (target) => {
              if (stopped || closed || submittedTargets.has(target)) return false;
              submittedTargets.add(target);
              return true;
            },
          })
          : await advancePortalLogin(page, portalSteps);
      } catch {
        // Leave unexpected browser failures to the visible window without leaking diagnostics.
      } finally {
        running = false;
        if (generation === current && outcome !== "pending") done = true;
        schedule();
      }
    };
    const navigation = (frame: ReturnType<Page["mainFrame"]>) => {
      if (frame !== page.mainFrame()) return;
      generation += 1;
      attempts = 0;
      done = false;
      schedule();
    };
    const cleanup = () => {
      closed = true;
      abort.abort();
      if (timer) clearTimeout(timer);
      page.off("framenavigated", navigation);
      page.off("domcontentloaded", schedule);
      page.off("close", cleanup);
      cleanups.delete(page);
    };
    cleanups.set(page, cleanup);
    page.on("framenavigated", navigation);
    page.on("domcontentloaded", schedule);
    page.on("close", cleanup);
    schedule();
  };
  const cleanup = () => {
    stopped = true;
    context.off("page", watch);
    context.off("close", cleanup);
    for (const stop of cleanups.values()) stop();
  };
  context.on("page", watch);
  context.on("close", cleanup);
  for (const page of context.pages()) watch(page);
  return cleanup;
}
