import type { Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approveBcnConsent, isBcnConsentPage } from "./bcnConsent";

const endpoint = "https://bemanicn.com/oauth/authorize";
const application = {
  rin: ["9c0c5e3f-f947-40d3-829f-b4f1dcb15dd2", "https://portal.naominet.live/oauth-callback/bcn"],
  otogame: ["96a3bae8-2990-4602-b86e-e5484b517f2e", "https://u.otogame.net/auth/callback"],
} as const;
type Source = keyof typeof application;

function fixtureUrl(source: Source, scope?: string) {
  const [clientId, redirectUri] = application[source];
  const params = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: "code", state: "fixture-state",
  });
  if (scope !== undefined) params.set("scope", scope);
  return `${endpoint}?${params}`;
}

class Hidden {
  type = "hidden";
  constructor(readonly name: string, private readonly content: string) {}
  get value() {
    if (this.name === "_token" || this.name === "auth_token") throw new Error("Token values must remain unread");
    return this.content;
  }
  matches() { return false; }
}

class Button {
  isConnected = true;
  type = "submit";
  name = "";
  attrs = new Set<string>();
  enabled = true;
  form?: Form;
  constructor(readonly textContent: string) {}
  hasAttribute(name: string) { return this.attrs.has(name); }
  getAttribute() { return null; }
  getClientRects() { return [{}]; }
  matches() { return !this.enabled; }
  click = vi.fn();
}

class Form {
  isConnected = true;
  action = endpoint;
  method = "post";
  target = "";
  enctype = "application/x-www-form-urlencoded";
  noValidate = false;
  fields: Hidden[];
  constructor(private readonly button: Button, source: Source, deny = false) {
    button.form = this;
    this.fields = [
      new Hidden("_token", "unread"), new Hidden("client_id", application[source][0]),
      new Hidden("state", "fixture-state"), new Hidden("auth_token", "unread"),
    ];
    if (deny) this.fields.push(new Hidden("_method", "DELETE"));
  }
  get elements() {
    return { length: this.fields.length + 1, namedItem: (name: string) => this.fields.find(field => field.name === name) };
  }
  contains(element: Hidden | Button) { return element === this.button || this.fields.includes(element as Hidden); }
}

function fixture(source: Source) {
  const approval = new Button("同意");
  const denial = new Button("拒绝");
  const state = { url: fixtureUrl(source), approval: [approval], scope: false };
  const approvalForm = new Form(approval, source);
  const denialForm = new Form(denial, source, true);
  const document = {
    title: "授权提示 - BEMANICN",
    body: { innerText: "授权提示" },
    querySelector() { return state.scope ? {} : null; },
    querySelectorAll(selector: string) {
      return selector.endsWith("-success") ? state.approval : [denial];
    },
  };
  const sync = () => {
    vi.stubGlobal("location", new URL(state.url));
    vi.stubGlobal("document", document);
    vi.stubGlobal("HTMLInputElement", Hidden);
    vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible" }));
  };
  const page = {
    url: () => state.url,
    async evaluateHandle(callback: (request: unknown) => unknown, request: unknown) {
      sync();
      const value = callback(request);
      return {
        async evaluate(fn: (value: unknown) => unknown) {
          sync();
          return fn(value);
        },
        dispose: vi.fn().mockResolvedValue(undefined),
      };
    },
  };
  return { page: page as unknown as Page, state, document, approval, denial, approvalForm, denialForm };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("BCN authorization request", () => {
  it("accepts only the selected source's exact authorization code request", () => {
    expect(isBcnConsentPage(fixtureUrl("rin"), "rin")).toBe(true);
    expect(isBcnConsentPage(fixtureUrl("otogame", ""), "otogame")).toBe(true);
    expect(isBcnConsentPage(fixtureUrl("rin"), "otogame")).toBe(false);
  });

  it("leaves expanded, ambiguous and unrelated requests manual", () => {
    for (const url of [
      fixtureUrl("rin", "profile"),
      fixtureUrl("rin") + "&state=duplicate",
      fixtureUrl("rin") + "&prompt=consent",
      fixtureUrl("rin") + "&scope=&scope=",
      fixtureUrl("rin").replace("fixture-state", ""),
      fixtureUrl("rin").replace("response_type=code", "response_type=token"),
      fixtureUrl("rin").replace("oauth-callback%2Fbcn", "oauth-callback%2Fother"),
      fixtureUrl("rin").replace("bemanicn.com", "bemanicn.com.example.test"),
      fixtureUrl("rin").replace("https://", "http://"),
      fixtureUrl("rin") + "#other",
    ]) expect(isBcnConsentPage(url, "rin")).toBe(false);
  });
});

describe("BCN native consent form", () => {
  it.each(["rin", "otogame"] as const)("claims the normal %s grant before clicking once", async source => {
    const view = fixture(source);
    const claim = vi.fn(() => expect(view.approval.click).not.toHaveBeenCalled());
    await approveBcnConsent(view.page, source, new AbortController().signal, claim);
    expect(claim).toHaveBeenCalledOnce();
    expect(view.approval.click).toHaveBeenCalledOnce();
    expect(view.denial.click).not.toHaveBeenCalled();
  });

  it("leaves changed form fields, scopes, terms and destinations for manual approval", async () => {
    for (const change of [
      (view: ReturnType<typeof fixture>) => { view.approvalForm.fields.push(new Hidden("scope", "new")); },
      (view: ReturnType<typeof fixture>) => { view.approvalForm.fields[2] = new Hidden("state", "wrong"); },
      (view: ReturnType<typeof fixture>) => { view.denialForm.fields[4] = new Hidden("_method", "POST"); },
      (view: ReturnType<typeof fixture>) => { view.document.title = "other document"; },
      (view: ReturnType<typeof fixture>) => { view.document.body.innerText = "阅读服务条款"; },
      (view: ReturnType<typeof fixture>) => { view.state.scope = true; },
      (view: ReturnType<typeof fixture>) => { view.approval.attrs.add("formaction"); },
      (view: ReturnType<typeof fixture>) => { view.approvalForm.action = "https://example.test/oauth/authorize"; },
      (view: ReturnType<typeof fixture>) => { view.approvalForm.method = "get"; },
      (view: ReturnType<typeof fixture>) => { view.state.approval.push(new Button("同意")); },
    ]) {
      const view = fixture("rin");
      const claim = vi.fn();
      change(view);
      await approveBcnConsent(view.page, "rin", new AbortController().signal, claim);
      expect(claim).not.toHaveBeenCalled();
      expect(view.approval.click).not.toHaveBeenCalled();
    }
  });

  it("does not click after cancellation or navigation during claim", async () => {
    for (const change of [
      (abort: AbortController) => { abort.abort(); },
      (_abort: AbortController, view: ReturnType<typeof fixture>) => {
        view.state.url = "https://bemanicn.com/login";
      },
    ]) {
      const view = fixture("otogame");
      const abort = new AbortController();
      await approveBcnConsent(view.page, "otogame", abort.signal, () => change(abort, view));
      expect(view.approval.click).not.toHaveBeenCalled();
    }
  });
});
