import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SourceSyncControls, type useSourceSync } from "./SourceSyncControls";
import { SYNC_SOURCES, type SourceConnection } from "../syncTypes";

type Controller = ReturnType<typeof useSourceSync>;

function controller(overrides: Partial<SourceConnection> = {}): Controller {
  return {
    connections: Object.fromEntries(SYNC_SOURCES.map((source) => [source, {
      source, status: "unbound", bound: false, identity: null,
      lastAttemptAt: null, lastSuccessAt: null, error: null,
      ...(source === "rin" ? overrides : {}),
    }])) as Controller["connections"],
    pending: {}, errors: {}, serviceError: null, loading: false,
    refresh: vi.fn().mockResolvedValue(undefined), run: vi.fn().mockResolvedValue(true),
  };
}

function button(markup: string, label: string): string {
  return markup.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0] ?? "";
}

describe("source sync controls", () => {
  it("requires a binding before sync while allowing initial browser login", () => {
    const html = renderToStaticMarkup(createElement(SourceSyncControls, { source: "rin", controller: controller() }));
    expect(button(html, "绑定账号")).not.toContain("disabled");
    expect(button(html, "同步成绩")).toContain("disabled");
    expect(button(html, "解绑")).toBe("");
  });

  it("displays the fixed card identity and enables syncing an existing binding", () => {
    const html = renderToStaticMarkup(createElement(SourceSyncControls, { source: "rin", controller: controller({
      status: "ready", bound: true, identity: { id: "user-1", label: "测试玩家", cardId: "456" },
    }) }));
    expect(html).toContain("测试玩家");
    expect(html).toContain("卡 456");
    expect(button(html, "同步成绩")).not.toContain("disabled");
    expect(button(html, "重新登录")).not.toContain("disabled");
  });

  it("keeps re-login available when authentication expires", () => {
    const html = renderToStaticMarkup(createElement(SourceSyncControls, { source: "rin", controller: controller({ status: "auth_required", bound: true, error: "会话失效" }) }));
    expect(button(html, "重新登录")).not.toContain("disabled");
    expect(button(html, "同步成绩")).toContain("disabled");
    expect(html).toContain("会话失效");
  });

  it("allows cancelling a browser binding while guarding duplicate login and sync", () => {
    const html = renderToStaticMarkup(createElement(SourceSyncControls, { source: "rin", controller: controller({ status: "binding" }) }));
    expect(button(html, "绑定账号")).toContain("disabled");
    expect(button(html, "同步成绩")).toContain("disabled");
    expect(button(html, "取消绑定")).not.toContain("disabled");
  });

  it("does not block other sources while one source is busy", () => {
    const state = controller({ status: "ready", bound: true });
    state.pending.rin = "sync";
    const rin = renderToStaticMarkup(createElement(SourceSyncControls, { source: "rin", controller: state }));
    const munet = renderToStaticMarkup(createElement(SourceSyncControls, { source: "munet", controller: state }));
    expect(button(rin, "正在同步")).toContain("disabled");
    expect(button(munet, "绑定账号")).not.toContain("disabled");
  });

  it("asks for a token only on first LXNS binding and uses a password field", () => {
    const state = controller();
    const unbound = renderToStaticMarkup(createElement(SourceSyncControls, { source: "lxns", controller: state }));
    expect(unbound).toContain('type="password"');
    expect(button(unbound, "保存 Token")).toContain("disabled");
    state.connections.lxns = { ...state.connections.lxns, status: "ready", bound: true };
    const bound = renderToStaticMarkup(createElement(SourceSyncControls, { source: "lxns", controller: state }));
    expect(bound).not.toContain('type="password"');
    expect(button(bound, "同步成绩")).not.toContain("disabled");
  });

  it("shows read progress and the server cooldown while preventing duplicate sync", () => {
    const state = controller();
    const retryAt = "2026-10-04T14:30:00.000Z";
    state.connections.otogame = {
      ...state.connections.otogame, status: "syncing", bound: true,
      progress: { completedPages: 43, retryAt },
    };
    const html = renderToStaticMarkup(createElement(SourceSyncControls, { source: "otogame", controller: state }));
    expect(html).toContain("已读取 43 页");
    expect(html).toContain("服务器限流");
    expect(html).toContain(new Date(retryAt).toLocaleTimeString("zh-CN", { hour12: false }));
    expect(html).toContain("请保持本页和本地服务运行");
    expect(button(html, "正在同步")).toContain("disabled");
    expect(button(html, "解绑")).toContain("disabled");
  });

  it("does not display a continuing wait after sync has stopped", () => {
    const state = controller({ status: "error", bound: true, progress: { completedPages: 43, retryAt: "2026-10-04T14:30:00.000Z" } });
    const html = renderToStaticMarkup(createElement(SourceSyncControls, { source: "rin", controller: state }));
    expect(html).not.toContain("已读取 43 页");
    expect(html).not.toContain("服务器限流");
    expect(button(html, "同步成绩")).not.toContain("disabled");
  });
});
import { createElement } from "react";
