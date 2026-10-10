import { chromium } from "playwright";
import type { BrowserSession } from "./provider";
import { SyncError } from "./provider";
import type { PortableSession } from "../src/sourceBindingTypes";
import { portableStorageState } from "./portableSession";

export interface BrowserLauncher {
  open(profilePath: string, url: string, visible: boolean): Promise<BrowserSession>;
  openPortable?(session: PortableSession, url: string): Promise<BrowserSession>;
}

export function createBrowserLauncher(): BrowserLauncher {
  return {
    async openPortable(session, url) {
      let browser;
      try { browser = await chromium.launch({ headless: true, timeout: 30_000 }); }
      catch { throw new SyncError("BROWSER_UNAVAILABLE", "无法启动无界面浏览器，请检查 Chromium 安装。", 503); }
      try {
        const context = await browser.newContext({ storageState: portableStorageState(session), viewport: { width: 1150, height: 820 }, acceptDownloads: false });
        context.on('close', () => { void browser.close().catch(() => undefined); });
        context.setDefaultTimeout(30_000); context.setDefaultNavigationTimeout(30_000);
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        return { context, page };
      } catch {
        await browser.close().catch(() => undefined);
        throw new SyncError('NETWORK_ERROR', '无法恢复门户会话，请检查网络或重新运行登录助手。', 502);
      }
    },
    async open(profilePath, url, visible) {
      let context;
      const options = {
        headless: !visible,
        viewport: { width: 1150, height: 820 },
        acceptDownloads: false,
        timeout: 30_000,
      };
      try {
        context = await chromium.launchPersistentContext(profilePath, options);
      } catch (error) {
        if (error instanceof Error && /Executable doesn't exist/.test(error.message)) {
          try {
            // Chrome still receives our dedicated profilePath; never use the user's main profile.
            context = await chromium.launchPersistentContext(profilePath, { ...options, channel: "chrome" });
          } catch {
            throw new SyncError("BROWSER_MISSING", "未找到可用浏览器，请先运行 pnpm browser:install，或安装 Google Chrome。", 503);
          }
        } else {
          throw new SyncError("BROWSER_UNAVAILABLE", "无法启动登录浏览器，请关闭占用该会话的窗口后重试。", 503);
        }
      }
      context.setDefaultTimeout(30_000);
      context.setDefaultNavigationTimeout(30_000);
      const page = context.pages()[0] ?? await context.newPage();
      try {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        return { context, page };
      } catch {
        await context.close();
        throw new SyncError("NETWORK_ERROR", "无法打开来源网站，请检查网络后重试。", 502);
      }
    },
  };
}

export const browserLauncher = createBrowserLauncher();
