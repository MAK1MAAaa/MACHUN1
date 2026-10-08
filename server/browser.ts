import { chromium } from "playwright";
import type { BrowserSession } from "./provider";
import { SyncError } from "./provider";

export interface BrowserLauncher {
  open(profilePath: string, url: string, visible: boolean): Promise<BrowserSession>;
}

export function createBrowserLauncher(): BrowserLauncher {
  return {
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
