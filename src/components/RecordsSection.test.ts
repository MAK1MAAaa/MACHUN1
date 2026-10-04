import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { catalog } from "../core/catalog";
import { chartKey } from "../core/b30";
import type { SingleRating } from "../types";
import { RecordsSection } from "./RecordsSection";

const renderState = vi.hoisted(() => ({ mode: "rating" as "rating" | "catalog" }));

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useState: (initialState: unknown) => react.useState(initialState === "rating" ? renderState.mode : initialState),
  };
});

function renderRecords(records: SingleRating[] = []): string {
  return renderToStaticMarkup(createElement(RecordsSection, {
    records, scores: Object.fromEntries(records.map((record) => [chartKey(record), record])),
    nicknameOverrides: {}, disabled: false, onEdit: vi.fn(), onDelete: vi.fn(),
  }));
}

function headers(html: string): string[] {
  return html.match(/<thead>([\s\S]*?)<\/thead>/)?.[1].match(/<th\b[^>]*>[\s\S]*?<\/th>/g) ?? [];
}

describe("records section", () => {
  beforeEach(() => { renderState.mode = "rating"; });
  it("starts with rating ranking, displays only ten rows, and keeps mutation buttons disabled on storage failure", () => {
    const records: SingleRating[] = catalog.slice(0, 12).map((chart, index) => ({
      id: chart.id, title: chart.title, difficulty: chart.difficulty, constant: chart.constant,
      score: 1_000_000, rating: 18 - index / 100, source: "manual", updatedAt: "2026-10-04T00:00:00Z",
    }));
    const html = renderToStaticMarkup(createElement(RecordsSection, {
      records, scores: Object.fromEntries(records.map((record) => [chartKey(record), record])),
      nicknameOverrides: {}, disabled: true, onEdit: vi.fn(), onDelete: vi.fn(),
    }));
    expect(html).toContain('aria-pressed="true">Rating 排名');
    expect(html).toContain("共 12 项");
    expect(html.match(/>修改分数<\/button>/g)).toHaveLength(10);
    expect(html.match(/disabled="">修改分数<\/button>/g)).toHaveLength(10);
    expect(html.match(/disabled="">删除<\/button>/g)).toHaveLength(10);
    expect(html).toContain("第 1 / 2 页");
    expect(html).not.toContain(">#11<");
    expect(html).not.toContain("全部分类");
    expect(html).not.toContain('aria-label="成绩来源"');
    expect(html).not.toContain('aria-label="按分数排序"');
    expect(html).not.toContain("aria-sort=");
    expect(headers(html)).toHaveLength(11);
  });

  it("displays an accessible empty result and disables every page navigation at page one", () => {
    const html = renderToStaticMarkup(createElement(RecordsSection, {
      records: [], scores: {}, nicknameOverrides: {}, disabled: false, onEdit: vi.fn(), onDelete: vi.fn(),
    }));
    expect(html).toContain("暂无匹配成绩");
    expect(html).toContain('colSpan="11"');
    expect(html).toContain('aria-label="成绩分页"');
    expect(html).toContain("第 1 / 1 页");
    for (const label of ["首页", "上一页", "下一页", "末页"]) {
      expect(html).toContain(`disabled="">${label}</button>`);
    }
  });

  it("shows difficulty, display level, and constant in separate cells in the rating view", () => {
    const chart = catalog.find((entry) => entry.constant === 13.5)!;
    const html = renderRecords([{
      id: chart.id, title: chart.title, difficulty: chart.difficulty, constant: chart.constant,
      score: 1_000_000, rating: 14.5, source: "munet", updatedAt: "2026-10-05T00:00:00Z",
    }]);
    const columns = headers(html);
    expect(columns[1]).toContain(">歌曲<");
    expect(columns[2]).toContain(">难度<");
    expect(columns[3]).toContain(">等级<");
    expect(columns[4]).toContain(">定数<");
    expect(html).toContain(`>${chart.difficulty}</span></td><td>13+</td><td>13.5</td>`);
    expect(columns[5]).toContain(">分类<");
    expect(columns[6]).toContain(">版本<");
    expect(html.slice(0, html.indexOf("<table"))).toContain('aria-label="搜索"');
    expect(columns.join("")).not.toContain('type="search"');
    expect(html).toContain(`class="records-metadata-cell">${chart.genre}</td>`);
    expect(html).toContain(`class="records-metadata-cell">${chart.version}</td>`);
  });

  it("places catalog filters above the shared table with independent level and constant options", () => {
    renderState.mode = "catalog";
    const html = renderRecords();
    const columns = headers(html);
    expect(columns).toHaveLength(10);
    const aboveTable = html.slice(0, html.indexOf("<table"));
    for (const label of ["搜索", "难度", "等级", "定数", "分类", "版本", "成绩来源"]) {
      expect(aboveTable).toContain(`aria-label="${label}"`);
    }
    expect(aboveTable).toContain('<option value="13">13</option>');
    expect(aboveTable).toContain('<option value="13+">13+</option>');
    expect(aboveTable).toContain('<option value="13.0">13.0</option>');
    expect(aboveTable).toContain('<option value="13.5">13.5</option>');
    expect(aboveTable).toContain('aria-pressed="false">显示未游玩谱面</button>');
    expect(aboveTable).toContain(">清除筛选</button>");
    expect(columns[7]).toContain('aria-label="按分数排序"');
    expect(columns[7]).toContain('aria-sort="none"');
    expect(html).toContain('colSpan="10"');
    expect(aboveTable).toContain("records-filters");
    expect(columns.join("")).not.toContain("<select");
    expect(columns.join("")).not.toContain('type="search"');
    expect(columns.join("")).not.toContain("清除筛选");
  });

  it("uses the same column structure in both modes with only an extra rank column", () => {
    const ratingColumns = headers(renderRecords()).map((header) => header.replace(/<[^>]*>/g, ""));
    renderState.mode = "catalog";
    const catalogColumns = headers(renderRecords()).map((header) => header.replace(/<[^>]*>/g, "").replace(" ↕", ""));
    expect(ratingColumns).toEqual(["排名", ...catalogColumns]);
    expect(catalogColumns).toEqual(["歌曲", "难度", "等级", "定数", "分类", "版本", "来源", "分数", "Rating", "操作"]);
    expect(renderRecords().match(/<col\b/g)).toHaveLength(10);
    renderState.mode = "rating";
    expect(renderRecords().match(/<col\b/g)).toHaveLength(11);
  });

  it("keeps the complete song title on a keyboard-accessible copy button, independently of score editing", () => {
    const chart = catalog.reduce((longest, current) => current.title.length > longest.title.length ? current : longest);
    const record: SingleRating = {
      id: chart.id, title: chart.title, difficulty: chart.difficulty, constant: chart.constant,
      score: 1_000_000, rating: 14.5, source: "munet", updatedAt: "2026-10-05T00:00:00Z",
    };
    const original = structuredClone(record);
    const html = renderToStaticMarkup(createElement(RecordsSection, {
      records: [record], scores: { [chartKey(record)]: record }, nicknameOverrides: {},
      disabled: true, onEdit: vi.fn(), onDelete: vi.fn(),
    }));
    const copyButton = html.match(/<button\b[^>]*class="record-title-copy"[^>]*>[\s\S]*?<\/button>/)?.[0];
    const escapedTitle = chart.title.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[character]!);
    expect(copyButton).toContain('type="button"');
    expect(copyButton).toContain(`title="${escapedTitle}"`);
    expect(copyButton).toContain(`aria-label="复制歌曲名称：${escapedTitle}"`);
    expect(copyButton).toContain(`>${escapedTitle}</button>`);
    expect(copyButton).not.toContain("disabled");
    expect(html).toContain('class="records-copy-status" role="status"');
    expect(record).toEqual(original);
  });
});
