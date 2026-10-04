import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachAutomaticLogin, createCredentialReader, fillCredentialsForPage, loginRuleForUrl } from "./credentials";
import { advancePortalLogin } from "./portalLogin";

vi.mock("./portalLogin", () => ({
  isPortalLoginPage: (url: string) => url === "https://portal.naominet.live/",
  advancePortalLogin: vi.fn().mockResolvedValue("manual"),
}));

const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function envFile(content: string): Promise<string> {
  const directory = await mkdtemp("/tmp/machun-credentials-test-");
  temporaryDirectories.push(directory);
  const path = join(directory, ".env");
  await writeFile(path, content, { mode: 0o600 });
  return path;
}

class FakeInput {
  private storedValue = "";
  disabled = false;
  readOnly = false;
  isConnected = true;
  form: FakeForm | null = null;
  dispatchEvent = vi.fn(() => true);
  get value() { return this.storedValue; }
  set value(value: string) { this.storedValue = value; }
  getClientRects() { return [{}]; }
}

class FakeForm extends EventTarget {
  methodAttribute: string | null = null;
  action = "https://bemanicn.com/login";
  buttons: FakeButton[] = [];
  get method() { return this.methodAttribute ?? "get"; }
  getAttribute(name: string) { return name === "method" ? this.methodAttribute : null; }
  querySelectorAll() { return this.buttons; }
}

class FakeButton {
  disabled = false;
  isConnected = true;
  textContent = "登录";
  form: FakeForm | null = null;
  nativeSubmitPrevented = false;
  getClientRects() { return [{}]; }
  getAttribute() { return null; }
  click = vi.fn(() => {
    if (this.form) this.nativeSubmitPrevented = !this.form.dispatchEvent(new Event("submit", { cancelable: true }));
  });
}

function loginPage(url: string) {
  const username = new FakeInput();
  const password = new FakeInput();
  const button = new FakeButton();
  const form = new FakeForm();
  if (url === "https://bemanicn.com/login") username.form = password.form = button.form = form;
  form.buttons = [button];
  const state = { url };
  const frame = {};
  const dispose = vi.fn().mockResolvedValue(undefined);
  const activate = () => {
    vi.stubGlobal("document", document);
    vi.stubGlobal("location", new URL(state.url));
    vi.stubGlobal("HTMLInputElement", FakeInput);
    vi.stubGlobal("HTMLButtonElement", FakeButton);
  };
  const page = Object.assign(new EventEmitter(), {
    url: () => state.url,
    mainFrame: () => frame,
    evaluateHandle: vi.fn(async (callback: (argument: unknown) => unknown, argument: unknown) => {
      activate();
      const value = callback(argument);
      return { evaluate: async (evaluate: (target: unknown, argument: unknown) => unknown, argument: unknown) => { activate(); return evaluate(value, argument); }, dispose };
    }),
  });
  const rule = loginRuleForUrl(url);
  const document = { querySelectorAll: (selector: string) => selector === rule?.usernameSelector ? [username] : selector === rule?.passwordSelector ? [password] : selector === "button" ? [button] : [] };
  activate();
  return { page: page as unknown as Page, events: page, state, frame, username, password, button, form, dispose };
}

describe("optional local credential configuration", () => {
  it("leaves missing and empty configuration in manual login mode", async () => {
    const path = await envFile("BCN_EMAIL=\nBCN_PASSWORD=\nMUNET_USERNAME=\nMUNET_PASSWORD=\n");
    expect(await createCredentialReader(path, {})("bcn")).toBeNull();
    expect(await createCredentialReader(path, {})("munet")).toBeNull();
    expect(await createCredentialReader(`${path}.missing`, {})("bcn")).toBeNull();
  });

  it("lazily reads quoted values and keeps credentials separate without changing process.env", async () => {
    const path = await envFile('BCN_EMAIL=test@example.invalid\nBCN_PASSWORD=" synthetic # password "\nMUNET_USERNAME=example-user\nMUNET_PASSWORD=example-pass\n');
    const reader = createCredentialReader(path, {});
    expect(await reader("bcn")).toEqual({ username: "test@example.invalid", password: " synthetic # password " });
    expect(await reader("munet")).toEqual({ username: "example-user", password: "example-pass" });
    await writeFile(path, "BCN_EMAIL=updated@example.invalid\nBCN_PASSWORD=updated-fake\n");
    expect(await reader("bcn")).toEqual({ username: "updated@example.invalid", password: "updated-fake" });
    const overridden = createCredentialReader(path, { BCN_EMAIL: "", BCN_PASSWORD: "" });
    expect(await overridden("bcn")).toBeNull();
  });

  it("allows only verified HTTPS origins and login paths", () => {
    expect(loginRuleForUrl("https://bemanicn.com/login?redirect=example")?.target).toBe("bcn");
    expect(loginRuleForUrl("https://portal.mumur.net/login")?.target).toBe("munet");
    for (const url of [
      "http://bemanicn.com/login", "https://bemanicn.com.attacker.invalid/login",
      "https://other.bemanicn.com/login", "https://bemanicn.com:8443/login",
      "https://bemanicn.com/register", "https://portal.mumur.net/user",
      "https://fake-user@bemanicn.com/login", "not a URL",
    ]) expect(loginRuleForUrl(url)).toBeUndefined();
  });
});

describe("official login form autofill", () => {
  it.each(["https://bemanicn.com/login", "https://portal.mumur.net/login"])("fills an empty verified form once without submitting: %s", async (url) => {
    const fake = loginPage(url);
    const read = vi.fn().mockResolvedValue({ username: "synthetic-user", password: "synthetic-secret" });
    expect(await fillCredentialsForPage(fake.page, read)).toBe("filled");
    expect(fake.username.value).toBe("synthetic-user");
    expect(fake.password.value).toBe("synthetic-secret");
    expect(fake.password.dispatchEvent.mock.calls.map((call) => (call as unknown as Event[])[0].type)).toEqual(["input", "change"]);
    expect(await fillCredentialsForPage(fake.page, read)).toBe("manual");
    expect(read).toHaveBeenCalledTimes(1);
    expect(fake.dispose).toHaveBeenCalledTimes(2);
  });

  it.each(["username", "password"] as const)("does not overwrite existing %s or mix saved credentials into that form", async (field) => {
    const fake = loginPage("https://bemanicn.com/login");
    fake[field].value = "user-entered-value";
    const read = vi.fn();
    expect(await fillCredentialsForPage(fake.page, read)).toBe("manual");
    expect(read).not.toHaveBeenCalled();
    expect(fake[field].value).toBe("user-entered-value");
    expect(fake[field === "username" ? "password" : "username"].value).toBe("");
  });

  it("does not overwrite input entered while the credential file was being read", async () => {
    const fake = loginPage("https://bemanicn.com/login");
    const read = vi.fn(async () => {
      fake.username.value = "typed-during-read";
      return { username: "synthetic-user", password: "synthetic-secret" };
    });
    expect(await fillCredentialsForPage(fake.page, read)).toBe("manual");
    expect(fake.username.value).toBe("typed-during-read");
    expect(fake.password.value).toBe("");
  });

  it("never reads credentials on an unapproved domain", async () => {
    const fake = loginPage("https://lookalike.invalid/login");
    const read = vi.fn();
    expect(await fillCredentialsForPage(fake.page, read)).toBe("manual");
    expect(read).not.toHaveBeenCalled();
    expect(fake.events.evaluateHandle).not.toHaveBeenCalled();
  });

  it("suppresses browser errors that could contain a secret", async () => {
    const fake = loginPage("https://bemanicn.com/login");
    fake.events.evaluateHandle.mockRejectedValue(new Error("synthetic-secret-in-browser-error"));
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    expect(await fillCredentialsForPage(fake.page, vi.fn())).toBe("pending");
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it("handles navigated pages and new SSO windows, and removes watchers on close", async () => {
    vi.useFakeTimers();
    const initial = loginPage("https://bemanicn.com/login");
    initial.state.url = "https://portal.naominet.live/";
    const context = Object.assign(new EventEmitter(), { pages: () => [initial.page] });
    const read = vi.fn().mockResolvedValue({ username: "synthetic-user", password: "synthetic-secret" });
    const cleanup = attachAutomaticLogin(context as unknown as BrowserContext, read);
    await vi.advanceTimersByTimeAsync(350);
    expect(read).not.toHaveBeenCalled();
    initial.state.url = "https://bemanicn.com/login";
    initial.events.emit("framenavigated", initial.frame);
    await vi.advanceTimersByTimeAsync(350);
    expect(initial.password.value).toBe("synthetic-secret");
    const popup = loginPage("https://portal.mumur.net/login");
    context.emit("page", popup.page);
    await vi.advanceTimersByTimeAsync(350);
    expect(popup.password.value).toBe("synthetic-secret");
    expect(read).toHaveBeenCalledTimes(2);
    context.emit("close");
    cleanup();
    expect(context.listenerCount("page")).toBe(0);
    expect(initial.events.listenerCount("framenavigated")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("one automatic password attempt per binding", () => {
  const credentials = { username: "synthetic-user", password: "synthetic-secret" };

  it.each(["https://bemanicn.com/login", "https://portal.mumur.net/login"])("clicks the official login button once: %s", async (url) => {
    const fake = loginPage(url);
    const claim = vi.fn(() => true);
    expect(await fillCredentialsForPage(fake.page, async () => credentials, { claim })).toBe("submitted");
    expect(claim).toHaveBeenCalledExactlyOnceWith(loginRuleForUrl(url)?.target);
    expect(fake.button.click).toHaveBeenCalledTimes(1);
    if (url.includes("bemanicn")) expect(fake.button.nativeSubmitPrevented).toBe(true);
  });

  it.each(["wrong-action", "explicit-get", "different-form"])("does not submit an unexpected BCN form: %s", async (variant) => {
    const fake = loginPage("https://bemanicn.com/login");
    if (variant === "wrong-action") fake.form.action = "https://unrelated.invalid/login";
    if (variant === "explicit-get") fake.form.methodAttribute = "get";
    if (variant === "different-form") fake.password.form = new FakeForm();
    const claim = vi.fn(() => true);
    expect(await fillCredentialsForPage(fake.page, async () => credentials, { claim })).toBe("manual");
    expect(fake.button.click).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it("preserves the behavior of an explicit POST form", async () => {
    const fake = loginPage("https://bemanicn.com/login");
    fake.form.methodAttribute = "post";
    expect(await fillCredentialsForPage(fake.page, async () => credentials, { claim: () => true })).toBe("submitted");
    expect(fake.button.nativeSubmitPrevented).toBe(false);
  });

  it("rechecks user edits immediately before the claimed click", async () => {
    const fake = loginPage("https://bemanicn.com/login");
    const claim = () => { fake.username.value = "changed-by-user"; return true; };
    expect(await fillCredentialsForPage(fake.page, async () => credentials, { claim })).toBe("manual");
    expect(fake.button.click).not.toHaveBeenCalled();
  });

  it("does not submit user-entered credentials or a previously claimed attempt", async () => {
    const fake = loginPage("https://portal.mumur.net/login");
    fake.username.value = "manual-user";
    const read = vi.fn(async () => credentials);
    expect(await fillCredentialsForPage(fake.page, read, { claim: () => true })).toBe("manual");
    expect(read).not.toHaveBeenCalled();
    fake.username.value = "";
    expect(await fillCredentialsForPage(fake.page, read, { claim: () => false })).toBe("filled");
    expect(fake.button.click).not.toHaveBeenCalled();
  });

  it("waits for the reactive login button and aborts without clicking or retaining timers", async () => {
    vi.useFakeTimers();
    const fake = loginPage("https://portal.mumur.net/login");
    fake.button.disabled = true;
    const abort = new AbortController();
    const pending = fillCredentialsForPage(fake.page, async () => credentials, { claim: () => true, signal: abort.signal });
    await vi.advanceTimersByTimeAsync(100);
    abort.abort();
    expect(await pending).toBe("filled");
    expect(fake.button.click).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves the form empty when cancelled during the credential read", async () => {
    const fake = loginPage("https://bemanicn.com/login");
    const abort = new AbortController();
    const read = async () => { abort.abort(); return credentials; };
    expect(await fillCredentialsForPage(fake.page, read, { claim: () => true, signal: abort.signal })).toBe("manual");
    expect(fake.username.value).toBe("");
    expect(fake.password.value).toBe("");
    expect(fake.button.click).not.toHaveBeenCalled();
  });

  it("never repeats after an error reload or a new window for the same login provider", async () => {
    vi.useFakeTimers();
    const fake = loginPage("https://bemanicn.com/login");
    const context = Object.assign(new EventEmitter(), { pages: () => [fake.page] });
    const read = vi.fn(async () => credentials);
    const cleanup = attachAutomaticLogin(context as unknown as BrowserContext, read);
    await vi.advanceTimersByTimeAsync(350);
    expect(fake.button.click).toHaveBeenCalledTimes(1);
    fake.username.value = fake.password.value = "";
    fake.events.emit("framenavigated", fake.frame);
    const popup = loginPage("https://bemanicn.com/login");
    context.emit("page", popup.page);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(fake.button.click).toHaveBeenCalledTimes(1);
    expect(popup.button.click).not.toHaveBeenCalled();
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("claims only one attempt when two login pages are ready concurrently", async () => {
    vi.useFakeTimers();
    const first = loginPage("https://bemanicn.com/login");
    const second = loginPage("https://bemanicn.com/login");
    const context = Object.assign(new EventEmitter(), { pages: () => [first.page, second.page] });
    const cleanup = attachAutomaticLogin(context as unknown as BrowserContext, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return credentials;
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(first.button.click.mock.calls.length + second.button.click.mock.calls.length).toBe(1);
    cleanup();
  });

  it("cancels a pending form wait when the browser closes", async () => {
    vi.useFakeTimers();
    const fake = loginPage("https://portal.mumur.net/login");
    fake.button.disabled = true;
    const context = Object.assign(new EventEmitter(), { pages: () => [fake.page] });
    attachAutomaticLogin(context as unknown as BrowserContext, async () => credentials);
    await vi.advanceTimersByTimeAsync(350);
    context.emit("close");
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.button.click).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(context.listenerCount("page")).toBe(0);
  });

  it("contains unexpected portal errors without logging diagnostics or retrying", async () => {
    vi.useFakeTimers();
    const fake = loginPage("https://portal.naominet.live/");
    vi.mocked(advancePortalLogin).mockRejectedValueOnce(new Error("synthetic-sensitive-error"));
    const context = Object.assign(new EventEmitter(), { pages: () => [fake.page] });
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    const cleanup = attachAutomaticLogin(context as unknown as BrowserContext, vi.fn());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.getTimerCount()).toBe(0);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    cleanup();
  });
});
