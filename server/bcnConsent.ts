import type { Page } from "playwright";

type BcnSource = "rin" | "otogame";

const AUTHORIZATION_URL = "https://bemanicn.com/oauth/authorize";
const CLIENTS = {
  rin: {
    clientId: "9c0c5e3f-f947-40d3-829f-b4f1dcb15dd2",
    redirectUri: "https://portal.naominet.live/oauth-callback/bcn",
  },
  otogame: {
    clientId: "96a3bae8-2990-4602-b86e-e5484b517f2e",
    redirectUri: "https://u.otogame.net/auth/callback",
  },
} as const;

function consentRequest(raw: string, source: BcnSource) {
  try {
    const url = new URL(raw);
    if (`${url.origin}${url.pathname}` !== AUTHORIZATION_URL || url.username || url.password || url.hash) return;
    const client = CLIENTS[source];
    const state = url.searchParams.get("state");
    const params = new Map([
      ["client_id", client.clientId], ["redirect_uri", client.redirectUri],
      ["response_type", "code"], ["state", state],
    ]);
    if (url.searchParams.has("scope")) params.set("scope", "");
    if (!state?.trim() || url.searchParams.size !== params.size) return;
    for (const [name, value] of params) {
      const matches = url.searchParams.getAll(name);
      if (matches.length !== 1 || matches[0] !== value) return;
    }
    return { url: url.href, state, clientId: client.clientId, action: AUTHORIZATION_URL };
  } catch {
    // Invalid or unavailable URL.
  }
}

export function isBcnConsentPage(raw: string, source: BcnSource): boolean {
  return consentRequest(raw, source) !== undefined;
}

export async function approveBcnConsent(page: Page, source: BcnSource, signal: AbortSignal,
  claim: () => void): Promise<void> {
  if (signal.aborted) return;
  const request = consentRequest(page.url(), source);
  if (!request) return;

  // The handle anchors both checks and the click to the original document.
  // Tokens stay in the native form and are never returned to the Node process.
  const consent = await page.evaluateHandle((expected) => {
    const approveButtons = document.querySelectorAll<HTMLButtonElement>("button.oauth-btn.oauth-btn-success");
    const approve = approveButtons[0];
    const approval = approve?.form;
    const denyButtons = document.querySelectorAll<HTMLButtonElement>("button.oauth-btn.oauth-btn-danger");
    const deny = denyButtons[0];
    const denial = deny?.form;
    if (approveButtons.length !== 1 || denyButtons.length !== 1 || !approval || !denial || approval === denial) return null;

    const checks = {
      button(button: HTMLButtonElement, label: string) {
        return button.isConnected && button.type === "submit" && !button.name
          && button.textContent?.trim() === label && !button.matches(":disabled")
          && button.getAttribute("aria-disabled") !== "true"
          && button.getClientRects().length > 0 && getComputedStyle(button).visibility === "visible"
          && !["formaction", "formmethod", "formenctype", "formtarget", "formnovalidate"].some(
            attribute => button.hasAttribute(attribute),
          );
      },
      form(form: HTMLFormElement, button: HTMLButtonElement, fields: string[]) {
        if (!form.isConnected || !form.contains(button) || button.form !== form || form.action !== expected.action
          || form.method !== "post" || form.target || form.enctype !== "application/x-www-form-urlencoded"
          || form.noValidate || form.elements.length !== fields.length + 1) return false;
        return fields.every(name => {
          const field = form.elements.namedItem(name);
          if (!(field instanceof HTMLInputElement) || field.name !== name || field.type !== "hidden"
            || !form.contains(field) || field.matches(":disabled")) return false;
          switch (name) {
            case "client_id": return field.value === expected.clientId;
            case "state": return field.value === expected.state;
            case "_method": return field.value === "DELETE";
            default: return true;
          }
        });
      },
      current() {
        return location.href === expected.url && document.title === "授权提示 - BEMANICN"
          && !document.querySelector('[class*="scope" i], [class*="permission" i], li, input[type="checkbox"], [role="checkbox"], [role="switch"]')
          && !/隐私政策|用户协议|服务条款|条款与条件|privacy policy|terms of (?:use|service)|terms and conditions/i.test(document.body?.innerText ?? "")
          && document.querySelectorAll("button.oauth-btn.oauth-btn-success").length === 1
          && document.querySelectorAll("button.oauth-btn.oauth-btn-danger").length === 1
          && this.button(approve, "同意") && this.button(deny, "拒绝")
          && this.form(approval!, approve, ["_token", "state", "client_id", "auth_token"])
          && this.form(denial!, deny, ["_token", "state", "client_id", "auth_token", "_method"]);
      },
      click() {
        if (this.current()) approve.click();
      },
    };
    return checks;
  }, request);
  try {
    if (!await consent.evaluate(view => view?.current()) || signal.aborted) return;
    claim();
    if (!signal.aborted) await consent.evaluate(view => view?.click());
  } finally {
    await consent.dispose().catch(() => undefined);
  }
}
