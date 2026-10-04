import assert from "node:assert/strict";
import type { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { attachAutomaticLogin, type CredentialTarget } from "../server/credentials";

// Every request is intercepted. These credentials only ever reach the in-memory fixture.
const credentials = { username: "auto-login-fixture@example.invalid", password: "synthetic-fixture-password" };
const loginUrls = { bcn: "https://bemanicn.com/login", munet: "https://portal.mumur.net/login" };
interface FixtureState {
  clicks: number;
  submits: number;
  phase: "ready" | "captcha" | "posting" | "failed";
  completeCaptcha?: () => void;
  allowSubmit(): void;
}
declare global { interface Window { __autoLoginFixture: FixtureState } }
interface InterceptedRequest { url: string; method: string; body: string | null }

function fixtureHtml(target: CredentialTarget, holdButton: boolean): string {
  const inputs = target === "bcn"
    ? '<input id="email" name="email" type="email" required><input id="password" name="password" type="password" required>'
    : '<input placeholder="用户名"><input placeholder="密码" type="password">';
  const content = `${inputs}<button type="${target === "bcn" ? "submit" : "button"}" disabled><span>登录</span></button>`;
  return `<!doctype html><html lang="zh"><head><meta charset="UTF-8"></head><body>
    ${target === "bcn" ? `<form>${content}</form>` : `<div>${content}</div>`}
    <div id="error"></div><div id="captcha" hidden>请完成人工验证</div>
    <script>
      const target = ${JSON.stringify(target)};
      const username = document.querySelector('input');
      const password = document.querySelector('input[type=password]');
      const button = document.querySelector('button');
      let holdButton = ${JSON.stringify(holdButton)};
      const state = window.__autoLoginFixture = {
        clicks: 0, submits: 0, phase: 'ready',
        allowSubmit() { holdButton = false; updateButton(); }
      };
      function updateButton() {
        button.disabled = holdButton || !username.value || !password.value || state.phase === 'posting' || state.phase === 'captcha';
      }
      for (const input of [username, password]) {
        // Model the framework's reactive update instead of enabling synchronously in fill().
        input.addEventListener('input', () => setTimeout(updateButton, 50));
      }
      button.addEventListener('click', () => state.clicks++);
      async function officialSubmit(event) {
        event.preventDefault();
        state.submits++;
        if (target === 'munet') {
          state.phase = 'captcha'; updateButton();
          document.querySelector('#captcha').hidden = false;
          await new Promise(resolve => { state.completeCaptcha = resolve; });
          document.querySelector('#captcha').hidden = true;
        }
        state.phase = 'posting'; updateButton();
        const body = target === 'bcn'
          ? { email: username.value, password: password.value }
          : { user: username.value, password: password.value, turnstile: 'synthetic-fixture-captcha' };
        const endpoint = target === 'bcn' ? '/login' : 'https://apidashboard3-cf.mumur.net/api/v3/Login';
        const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const result = await response.json();
        document.querySelector('#error').textContent = result.message;
        // A failed login can render a fresh empty form. It must never start an automatic retry.
        username.value = ''; password.value = '';
        state.phase = 'failed'; updateButton();
      }
      if (target === 'bcn') document.querySelector('form').addEventListener('submit', officialSubmit);
      else button.addEventListener('click', officialSubmit);
    </script>
  </body></html>`;
}

// Playwright implements EventEmitter but omits this inspection method from its public types.
function countListeners(target: BrowserContext | Page, event: string): number {
  return (target as unknown as Pick<EventEmitter, "listenerCount">).listenerCount(event);
}

function listenerCounts(context: BrowserContext, page: Page) {
  return {
    contextPage: countListeners(context, "page"), contextClose: countListeners(context, "close"),
    frame: countListeners(page, "framenavigated"), ready: countListeners(page, "domcontentloaded"), close: countListeners(page, "close"),
  };
}

async function fixture(browser: Browser, target: CredentialTarget, holdButton = false) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const requests: InterceptedRequest[] = [];
  const html = fixtureHtml(target, holdButton);
  await context.route("**/*", async (route) => {
    const request = route.request();
    requests.push({ url: request.url(), method: request.method(), body: request.postData() });
    const url = new URL(request.url());
    const login = new URL(loginUrls[target]);
    if (request.method() === "GET" && url.origin === login.origin && url.pathname === "/login") {
      await route.fulfill({ status: 200, contentType: "text/html", body: html });
    } else if (request.method() === "OPTIONS" && url.origin === "https://apidashboard3-cf.mumur.net") {
      await route.fulfill({ status: 204, headers: {
        "Access-Control-Allow-Origin": login.origin, "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "content-type",
      } });
    } else if (request.method() === "POST" && (request.url() === loginUrls[target]
      || target === "munet" && request.url() === "https://apidashboard3-cf.mumur.net/api/v3/Login")) {
      await route.fulfill({ status: 200, contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": login.origin },
        body: JSON.stringify({ success: false, message: "合成登录失败" }),
      });
    } else {
      // No route can fall through to the Internet, including scripts, images, or popups.
      await route.abort("blockedbyclient");
    }
  });
  const page = await context.newPage();
  await page.goto(loginUrls[target], { waitUntil: "domcontentloaded" });
  const baseline = listenerCounts(context, page);
  let reads = 0;
  const stop = attachAutomaticLogin(context, async (requested) => {
    assert.equal(requested, target);
    reads += 1;
    return credentials;
  });
  return { context, page, requests, baseline, stop, reads: () => reads };
}

async function assertEmpty(page: Page): Promise<void> {
  assert(await page.locator("input").evaluateAll((inputs) => inputs.every((input) => !(input as HTMLInputElement).value)),
    "a failed or stopped session must leave the new empty form untouched");
}

function assertPosts(requests: InterceptedRequest[], target: CredentialTarget, count: number): void {
  const posts = requests.filter((request) => request.method === "POST");
  assert.equal(posts.length, count, "only the official submit handler may issue one password POST");
  for (const request of posts) {
    const body = JSON.parse(request.body ?? "null") as Record<string, string>;
    assert(body && body[target === "bcn" ? "email" : "user"] === credentials.username && body.password === credentials.password,
      "official handler must receive the synthetic credentials");
  }
  assert(requests.every((request) => {
    if (request.method !== "GET") return true;
    const url = new URL(request.url);
    return !url.search && !url.username && !url.password && !request.body;
  }), "native GET fallback must never place credentials in the request URL");
}

async function popup(page: Page): Promise<Page> {
  const [opened] = await Promise.all([
    page.context().waitForEvent("page"),
    page.evaluate(() => { window.open(location.href, "_blank"); }),
  ]);
  await opened.waitForLoadState("domcontentloaded");
  return opened;
}

async function checkSingleAttempt(browser: Browser, target: CredentialTarget): Promise<void> {
  const test = await fixture(browser, target);
  try {
    if (target === "bcn") {
      assert(await test.page.locator("form").evaluate((form) => !form.hasAttribute("method") && !form.hasAttribute("action")),
        "BCN fixture must exercise the official JS-only form shape");
    } else {
      await test.page.waitForFunction(() => window.__autoLoginFixture.phase === "captcha");
      await delay(650);
      assertPosts(test.requests, target, 0);
      assert.equal(await test.page.evaluate(() => window.__autoLoginFixture.clicks), 1);
      assert.equal(test.reads(), 1);
      // This resolves our own fixture promise; it never touches a real CAPTCHA.
      await test.page.evaluate(() => window.__autoLoginFixture.completeCaptcha?.());
    }
    await test.page.waitForFunction(() => window.__autoLoginFixture.phase === "failed");
    assert.equal(await test.page.evaluate(() => window.__autoLoginFixture.clicks), 1);
    assert.equal(await test.page.evaluate(() => window.__autoLoginFixture.submits), 1);
    await delay(650);
    await assertEmpty(test.page);
    assertPosts(test.requests, target, 1);
    await test.page.goto(loginUrls[target], { waitUntil: "domcontentloaded" });
    const opened = await popup(test.page);
    await delay(650);
    await assertEmpty(test.page);
    await assertEmpty(opened);
    assert.equal(test.reads(), 1, "failure, navigation, and a new window must share the one-attempt limit");
    assertPosts(test.requests, target, 1);
    const popupListeners = listenerCounts(test.context, opened);
    test.stop();
    test.stop();
    assert.deepEqual(listenerCounts(test.context, test.page), test.baseline);
    const removed = listenerCounts(test.context, opened);
    for (const key of ["frame", "ready", "close"] as const) assert.equal(removed[key], popupListeners[key] - 1);
    console.log(`PASS: ${target} official handler, single POST, no credential GET, no retry after failure/navigation/popup, listener cleanup`);
  } finally {
    test.stop();
    await test.context.close();
  }
}

async function checkCleanupWhileWaiting(browser: Browser, closeContext: boolean): Promise<void> {
  const test = await fixture(browser, "bcn", true);
  try {
    await test.page.waitForFunction(() => Boolean(document.querySelector<HTMLInputElement>("input[type=password]")?.value));
    if (closeContext) {
      await test.context.close();
      assert.equal(countListeners(test.context, "page"), test.baseline.contextPage);
      // Closing also removes Playwright's own one-shot close listener from the baseline.
      assert.equal(countListeners(test.context, "close"), 0);
    } else {
      test.stop();
      assert.deepEqual(listenerCounts(test.context, test.page), test.baseline);
      await test.page.evaluate(() => window.__autoLoginFixture.allowSubmit());
      await delay(650);
      assert.equal(await test.page.evaluate(() => window.__autoLoginFixture.clicks), 0);
      await test.page.goto(loginUrls.bcn, { waitUntil: "domcontentloaded" });
      const opened = await popup(test.page);
      await delay(650);
      await assertEmpty(test.page);
      await assertEmpty(opened);
    }
    assert.equal(test.reads(), 1);
    assertPosts(test.requests, "bcn", 0);
    console.log(`PASS: ${closeContext ? "context close" : "stop during reactive form wait"} cancels submission and removes watchers`);
  } finally {
    test.stop();
    await test.context.close();
  }
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  await checkSingleAttempt(browser, "bcn");
  await checkSingleAttempt(browser, "munet");
  await checkCleanupWhileWaiting(browser, false);
  await checkCleanupWhileWaiting(browser, true);
  console.log("PASS: automatic login Chrome smoke; all browser requests intercepted, synthetic credentials only");
} finally {
  await browser.close();
}
