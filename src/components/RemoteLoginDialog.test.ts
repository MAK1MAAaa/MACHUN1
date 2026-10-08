import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { isLocalLoginUrl, RemoteLoginDialog } from "./RemoteLoginDialog";

describe("remote manual login window", () => {
  it.each(["https://attacker.example/login", "//attacker.example/login", "/login-view/other.html", "/login-view/vnc.html#url=elsewhere", undefined])("does not frame an external or unrecognized URL: %s", (url) => {
    expect(isLocalLoginUrl(url)).toBe(false);
  });
  it("embeds the local desktop and explains returning to the scores page", () => {
    const url = "/login-view/vnc.html?autoconnect=true&resize=scale&path=login-view/websockify";
    const markup = renderToStaticMarkup(createElement(RemoteLoginDialog, { source: "rin", url, onClose: vi.fn() }));
    expect(markup).toContain('title="Rin服手动登录窗口"');
    expect(markup).toContain("绑定成功后自动返回成绩页面");
    expect(markup).toContain("返回成绩页面");
    expect(markup).not.toContain("自动登录");
  });
});
