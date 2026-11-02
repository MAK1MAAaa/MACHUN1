import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App from "./App";
import type { WorkspaceSnapshot } from "./accountTypes";
import { catalog } from "./core/catalog";
import { calculateRating } from "./core/rating";
import type { SingleRating } from "./types";

describe("account data toolbar", () => {
  it("shows three ordered actions without expansion, import modes or explanatory content", () => {
    const initial: WorkspaceSnapshot = {
      state: { schemaVersion: 2, scores: {}, nicknameOverrides: {} },
      revision: 0, legacyMigrated: true, exportNickname: "",
    };
    const html = renderToStaticMarkup(createElement(App, { account: { username: "test" }, initial }));
    const toolbar = html.match(/<section class="account-data-toolbar"[^>]*>([\s\S]*?)<\/section>/)?.[1] ?? "";

    expect(Boolean(toolbar)).toBe(true);
    expect(toolbar).toContain('<h2 id="account-data-title">账号数据</h2>');
    expect([...toolbar.matchAll(/<button\b[^>]*>([^<]*)<\/button>/g)].map(match => match[1]))
      .toEqual(["导入备份", "导出备份", "清除数据"]);
    expect(toolbar.indexOf("账号数据")).toBeLessThan(toolbar.indexOf("导入备份"));
    expect(/<(?:select|p|small|dl|aside)\b/.test(toolbar)).toBe(false);
    expect(toolbar).toContain('type="file"');
    expect(toolbar).toContain('hidden=""');
    expect(html.includes("local-tools-toggle")).toBe(false);
    expect(html.includes("展开工具")).toBe(false);
  });
});

describe("workspace B30 display", () => {
  it.each([0, 35])("keeps analysis and exports without an inline card preview for %i records", (count) => {
    const records: SingleRating[] = catalog.slice(0, count).map((chart, index) => {
      const score = 1_000_000 + index * 123;
      return {
        id: chart.id, title: chart.title, difficulty: chart.difficulty, constant: chart.constant,
        score, rating: calculateRating(score, chart.constant), source: "manual", updatedAt: "2026-11-02T11:00:00Z",
      };
    });
    const initial: WorkspaceSnapshot = {
      state: { schemaVersion: 2, scores: Object.fromEntries(records.map(record => [`${record.id}:${record.difficulty}`, record])), nicknameOverrides: {} },
      revision: 0, legacyMigrated: true, exportNickname: "",
    };
    const html = renderToStaticMarkup(createElement(App, { account: { username: "test" }, initial }));
    const expectedRating = (records.map(record => record.rating).sort((a, b) => b - a).slice(0, 30)
      .reduce((sum, rating) => sum + rating, 0) / 30).toFixed(4);

    expect(html).not.toContain("b30-preview-toggle");
    expect(html).not.toContain("b30-image-preview");
    expect(html).not.toContain("b30-grid");
    expect(html).not.toContain("展开 B30 图片");
    expect(html).toContain('aria-label="B30 Rating 柱状分析"');
    expect(html).toContain(`<span>Rating</span><strong>${expectedRating}</strong>`);
    expect(html.match(/class="b30-bar-item /g)).toHaveLength(30);
    for (const label of ["导出 B30 JSON", "导出 B30 + 候选20 JSON", "导出 B30 图片", "导出 B30 + 候选20 图片", "导出 AJ B30 图片", "导出 B50 图片"]) {
      expect(html).toContain(`>${label}</button>`);
    }
  });
});
