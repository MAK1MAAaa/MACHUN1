import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { catalog } from "../core/catalog";
import { chartKey } from "../core/b30";
import type { RecordsFilters } from "../core/recordsView";
import type { SingleRating } from "../types";
import { RecordsSection } from "./RecordsSection";

const renderState = vi.hoisted(() => ({ mode: "rating" as "rating" | "catalog", filters: {} as Partial<RecordsFilters>, filtersExpanded: false }));

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useState: (initialState: unknown) => react.useState(initialState === "rating" ? renderState.mode
      : initialState === false ? renderState.filtersExpanded
      : initialState && typeof initialState === "object" && "includeUnplayed" in initialState ? { ...initialState, ...renderState.filters }
      : initialState),
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
  beforeEach(() => { renderState.mode = "rating"; renderState.filters = {}; renderState.filtersExpanded = false; });
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
    expect(html).toContain(`>${chart.difficulty}</span></td><td class="records-level-cell" data-label="等级">13+</td><td class="records-constant-cell" data-label="定数">13.5</td>`);
    expect(columns[5]).toContain(">分类<");
    expect(columns[6]).toContain(">版本<");
    expect(html.slice(0, html.indexOf("<table"))).toContain('aria-label="搜索"');
    expect(columns.join("")).not.toContain('type="search"');
    expect(html).toContain(`class="records-metadata-cell records-genre-cell" data-label="分类">${chart.genre}</td>`);
    expect(html).toContain(`class="records-metadata-cell records-version-cell" data-label="版本">${chart.version}</td>`);
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

  it("reuses one set of row controls and preserves all information for the mobile card layout", () => {
    const chart = catalog[0];
    const html = renderRecords([{
      id: chart.id, title: chart.title, difficulty: chart.difficulty, constant: chart.constant,
      score: 1_009_000, rating: 16.9, source: "rin", combo: "aj", fullChain: "platinum", updatedAt: "2026-10-13T00:00:00Z",
    }]);
    expect(html.match(/class="record-title-details"/g)).toHaveLength(1);
    expect(html.match(/>修改分数<\/button>/g)).toHaveLength(1);
    expect(html.match(/>删除<\/button>/g)).toHaveLength(1);
    for (const label of ["排名", "难度", "等级", "定数", "分类", "版本", "来源", "分数", "Rating"]) {
      expect(html).toContain(`data-label="${label}"`);
    }
    expect(html).toContain('class="records-score-value">1,009,000</span>');
    expect(html).toContain('class="rating-cell">16.9000</strong>');
    expect(html).toContain('title="评级 SSS+"');
    expect(html).toContain('score-combo-aj');
    expect(html).toContain('score-chain-platinum');
    expect(html).toContain('score-source rin');
    expect(html).toContain(">#1<");
  });

  it("keeps search available while the mobile advanced filters have one accessible expansion control", () => {
    renderState.mode = "catalog";
    renderState.filters = { level: "13", difficulty: "MAS", source: "munet" };
    const html = renderRecords();
    expect(html.match(/aria-controls="records-advanced-filters"/g)).toHaveLength(1);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('展开筛选<span class="records-filter-count">3</span>');
    expect(html).toContain('id="records-advanced-filters" class="records-advanced-filters"');
    expect(html.indexOf('aria-label="搜索"')).toBeLessThan(html.indexOf('id="records-advanced-filters"'));
    expect(html.match(/aria-label="按分数排序"/g)).toHaveLength(1);
    renderState.filtersExpanded = true;
    const expanded = renderRecords();
    expect(expanded).toContain('aria-expanded="true"');
    expect(expanded).toContain('class="records-advanced-filters is-expanded"');
    expect(expanded).toContain('收起筛选<span class="records-filter-count">3</span>');
  });

  it("keeps the complete song title on an accessible details button independently of score editing", () => {
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
    const detailsButton = html.match(/<button\b[^>]*class="record-title-details"[^>]*>[\s\S]*?<\/button>/)?.[0];
    const escapedTitle = chart.title.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[character]!);
    expect(detailsButton).toContain('type="button"');
    expect(detailsButton).toContain(`title="${escapedTitle}"`);
    expect(detailsButton).toContain(`aria-label="查看歌曲详情：${escapedTitle}"`);
    expect(detailsButton).toContain('aria-haspopup="dialog"');
    expect(detailsButton).toContain(`>${escapedTitle}</button>`);
    expect(detailsButton).not.toContain("disabled");
    expect(html).not.toContain("record-title-copy");
    expect(record).toEqual(original);
  });
});
