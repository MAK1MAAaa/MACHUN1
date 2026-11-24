import { EventEmitter } from "node:events";
import type { BrowserContext, Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserSource } from "../src/syncTypes";
import * as bcnConsent from "./bcnConsent";
import { attachAutomaticLogin } from "./portalLogin";

const credentials = { username: "fixture@example.test", password: "fixture-password" };
const bcnLogin = "https://bemanicn.com/login";
const muNetLogin = "https://portal.mumur.net/login";
const aborts: AbortController[] = [];

afterEach(() => {
  for (const abort of aborts.splice(0)) abort.abort();
  vi.unstubAllGlobals();
});

class Input {
  private text = "";
  get value() { return this.text; }
  set value(value: string) { this.text = value; }
  form: Form | null = null;
  isConnected = true;
  readOnly = false;
  getClientRects() { return [{}]; }
  matches() { return false; }
  dispatchEvent = vi.fn();
}

class Form extends EventTarget {
  action = bcnLogin;
  method = "get";
  methodAttribute: string | null = null;
  buttons: Button[] = [];
  querySelectorAll() { return this.buttons; }
  getAttribute() { return this.methodAttribute; }
}

class Button {
  form: Form | null = null;
  type = "submit";
  textContent = "登 录";
  attributes = new Map<string, string>();
  getClientRects() { return [{}]; }
  matches() { return false; }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string) { return this.attributes.has(name); }
  nativeGet = false;
  click = vi.fn(() => {
    if (this.form) this.nativeGet = this.form.dispatchEvent(new Event("submit", { cancelable: true }))
      && this.form.method === "get";
  });
}

function fakePage(url: string, withForm = false) {
  const username = new Input();
  const password = new Input();
  const button = new Button();
  const form = new Form();
  if (withForm) {
    username.form = password.form = button.form = form;
    form.buttons = [button];
  }
  const state = { url, usernames: [username], closed: false };
  const document = {
    querySelectorAll(selector: string) {
      if (selector.includes("password") && !selector.includes(":not")) return [password];
      if (selector === "button") return [button];
      return state.usernames;
    },
  };
  const activate = () => {
    vi.stubGlobal("document", document);
    vi.stubGlobal("location", new URL(state.url));
    vi.stubGlobal("HTMLInputElement", Input);
    vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible" }));
  };
  const entryHandle = { click: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
  const entry = {
    count: vi.fn(async () => 1), isVisible: vi.fn(async () => true), isEnabled: vi.fn(async () => true),
    elementHandle: vi.fn(async () => entryHandle),
  };
  const beforeEvaluate = vi.fn();
  const page = {
    url: () => state.url,
    isClosed: () => state.closed,
    goto: vi.fn(async (next: string) => { state.url = next; }),
    locator: vi.fn(() => entry),
    getByRole: vi.fn(() => entry),
    evaluateHandle: vi.fn(async (callback: (argument: unknown) => unknown, argument: unknown) => {
      activate();
      const value = callback(argument);
      return {
        async evaluate(evaluate: (target: unknown, argument: unknown) => unknown, argument: unknown) {
          beforeEvaluate(argument);
          activate();
          return evaluate(value, argument);
        },
        dispose: async () => {},
      };
    }),
  };
  return { page: page as unknown as Page, mock: page, state, form, username, password, button, beforeEvaluate, entry, entryHandle };
}

function testContext(pages: Page[], source: BrowserSource) {
  const context = Object.assign(new EventEmitter(), { pages: () => pages });
  const abort = new AbortController();
  aborts.push(abort);
  const stop = attachAutomaticLogin(context as unknown as BrowserContext, source, credentials, abort.signal);
  return { context, stop, abort };
}

describe("automatic portal login", () => {
  it("continues to BCN consent after submitting the prompted Rin credentials", async () => {
    const rin = fakePage("https://portal.naominet.live/sign-in");
    const bcn = fakePage(bcnLogin, true);
    const consentUrl = "https://bemanicn.com/oauth/authorize?client_id=9c0c5e3f-f947-40d3-829f-b4f1dcb15dd2"
      + "&redirect_uri=https%3A%2F%2Fportal.naominet.live%2Foauth-callback%2Fbcn&response_type=code&state=fixture-state";
    const pages = [rin.page];
    rin.entryHandle.click.mockImplementationOnce(async () => { pages.push(bcn.page); });
    bcn.button.click.mockImplementationOnce(() => { bcn.state.url = consentUrl; });
    const approve = vi.spyOn(bcnConsent, "approveBcnConsent").mockImplementation(async (_page, _source, _signal, claim) => claim());
    try {
      const { context } = testContext(pages, "rin");
      await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce(), { timeout: 2_000 });
      expect(approve).toHaveBeenCalledWith(bcn.page, "rin", expect.any(AbortSignal), expect.any(Function));
      expect(bcn.button.click).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(context.listenerCount("close")).toBe(0));
    } finally {
      approve.mockRestore();
    }
  });

  it("submits MuNET's normal login once across windows and leaves challenge controls untouched", async () => {
    const first = fakePage(muNetLogin);
    const second = fakePage(muNetLogin);
    const unrelated = fakePage(bcnLogin, true);
    const { context } = testContext([unrelated.page, first.page, second.page], "munet");
    await vi.waitFor(() => expect(first.button.click).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(context.listenerCount("close")).toBe(0));
    expect(first.username.value).toBe(credentials.username);
    expect(first.password.value).toBe(credentials.password);
    expect(second.mock.evaluateHandle).not.toHaveBeenCalled();
    expect(unrelated.mock.evaluateHandle).not.toHaveBeenCalled();
    expect(first.mock.getByRole).not.toHaveBeenCalled();
  });

  it("opens Rin's official sign-in, follows the BCN button, and fills a newly opened BCN window", async () => {
    const rin = fakePage("https://portal.naominet.live/");
    const bcn = fakePage(bcnLogin, true);
    const consent = fakePage("https://bemanicn.com/oauth/authorize");
    const pages = [rin.page, consent.page];
    rin.entryHandle.click.mockImplementationOnce(async () => { pages.push(bcn.page); });
    testContext(pages, "rin");
    await vi.waitFor(() => expect(bcn.button.click).toHaveBeenCalledOnce(), { timeout: 2_000 });
    expect(rin.mock.goto).toHaveBeenCalledExactlyOnceWith(
      "https://portal.naominet.live/sign-in", expect.objectContaining({ waitUntil: "domcontentloaded" }));
    expect(rin.mock.getByRole).toHaveBeenCalledExactlyOnceWith("button", {
      name: /^(使用 BEMANICN 继续|Continue with BEMANICN)$/,
    });
    expect(bcn.password.value).toBe(credentials.password);
    expect(bcn.button.nativeGet).toBe(false);
    expect(consent.mock.evaluateHandle).not.toHaveBeenCalled();
    expect(consent.mock.getByRole).not.toHaveBeenCalled();
  });

  it("opens OTO's login modal and uses its BCN route once", async () => {
    const oto = fakePage("https://u.otogame.net/auth/login");
    const bcn = fakePage(bcnLogin, true);
    const pages = [oto.page];
    oto.entry.count.mockResolvedValueOnce(0);
    oto.entryHandle.click.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { pages.push(bcn.page); });
    testContext(pages, "otogame");
    await vi.waitFor(() => expect(bcn.button.click).toHaveBeenCalledOnce(), { timeout: 2_000 });
    expect(oto.mock.locator).toHaveBeenCalledExactlyOnceWith(".result-action-area .auth-button.login");
    expect(oto.mock.getByRole).toHaveBeenCalledWith("button", { name: "使用BCN账户登录", exact: true });
    expect(oto.entryHandle.click).toHaveBeenCalledTimes(2);
  });

  it("waits for user-entered fields without altering or submitting them", async () => {
    const page = fakePage(muNetLogin);
    page.username.value = "manual";
    const { context } = testContext([page.page], "munet");
    await vi.waitFor(() => expect(context.listenerCount("close")).toBe(0));
    expect(page.button.click).not.toHaveBeenCalled();
    expect(page.password.value).toBe("");
    expect(page.username.value).toBe("manual");
  });

  it("does not send credentials on near-match hosts, changed forms or multiple matches", async () => {
    const lookalike = fakePage("https://bemanicn.com.example.test/login", true);
    const crossOrigin = fakePage(bcnLogin, true);
    crossOrigin.form.action = "https://example.test/login";
    const ambiguous = fakePage(bcnLogin, true);
    ambiguous.state.usernames.push(new Input());
    const { abort } = testContext([lookalike.page, crossOrigin.page, ambiguous.page], "otogame");
    await vi.waitFor(() => expect(ambiguous.mock.evaluateHandle).toHaveBeenCalled());
    abort.abort();
    expect(lookalike.mock.evaluateHandle).not.toHaveBeenCalled();
    for (const page of [crossOrigin, ambiguous]) {
      expect(page.password.value).toBe("");
      expect(page.button.click).not.toHaveBeenCalled();
    }
  });

  it("does not fill a document that navigated while its fields were being checked", async () => {
    const page = fakePage(muNetLogin);
    page.beforeEvaluate.mockImplementation((argument: unknown) => {
      if (argument === credentials) page.state.url = "https://example.test/login";
    });
    const { context } = testContext([page.page], "munet");
    await vi.waitFor(() => expect(context.listenerCount("close")).toBe(0));
    expect(page.username.value).toBe("");
    expect(page.password.value).toBe("");
    expect(page.button.click).not.toHaveBeenCalled();
  });

  it("does not submit a form whose button overrides its submission method or destination", async () => {
    const page = fakePage(bcnLogin, true);
    page.button.attributes.set("formmethod", "get");
    const { context } = testContext([page.page], "rin");
    await vi.waitFor(() => expect(context.listenerCount("close")).toBe(0));
    expect(page.button.click).not.toHaveBeenCalled();
  });

  it("allows cancellation while a portal renders its disabled login button", async () => {
    const page = fakePage(muNetLogin);
    page.button.attributes.set("aria-disabled", "true");
    const { context, stop } = testContext([page.page], "munet");
    await vi.waitFor(() => expect(page.password.value).toBe(credentials.password));
    stop();
    page.button.attributes.clear();
    expect(context.listenerCount("close")).toBe(0);
    expect(page.button.click).not.toHaveBeenCalled();
  });
});
