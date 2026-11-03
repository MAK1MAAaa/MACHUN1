import { describe, expect, it, vi } from "vitest";
import type { CatalogChart, SingleRating } from "../types";
import { chartKey } from "./b30";
import { buildConstantTableGroups, constantTableLamp, DEFAULT_CONSTANT_TABLE_FILTERS, reconcileConstantSelection, resolveConstantTableSelection, toggleConstantSelection, validateConstantSelection } from "./constantTable";

const dates = vi.hoisted(() => ({ old: "2020-01-01", new: "2026-01-01", "2": "2020-01-01", "10": "2020-01-01" } as Record<string, string>));
vi.mock("./chartReleaseDates", () => ({ getChartReleaseDate: (chart: CatalogChart) => dates[chart.id] ?? null }));

function chart(id: string, extra: Partial<CatalogChart> = {}): CatalogChart {
  return { id, title: id, difficulty: "MAS", constant: 14, genre: "ORIGINAL", version: "MATE", nickname: [],
    coverUrl: "https://example.com/cover.png", bpm: null, notes: { total: 0, tap: 0, hold: 0, slide: 0, air: 0, flick: 0 }, ...extra };
}
function record(data: CatalogChart, extra: Partial<SingleRating> = {}): SingleRating {
  return { id: data.id, title: data.title, difficulty: data.difficulty, constant: data.constant, score: 1_009_000,
    rating: 16.15, source: "manual", updatedAt: "2026-11-01T00:00:00Z", ...extra };
}

describe("constant table selection", () => {
  it("selects every available constant within one level without crossing its boundary", () => {
    const charts = [14.5, 14.4, 14.2, 14, 14.3, 14.1, 13.9].map((constant, index) => chart(String(index), { constant }));
    const filters = { ...DEFAULT_CONSTANT_TABLE_FILTERS, level: "14" };
    const constants = resolveConstantTableSelection(charts, filters, "all");
    expect(constants).toEqual(["14.0", "14.1", "14.2", "14.3", "14.4"]);
    expect(buildConstantTableGroups(charts, {}, { ...filters, constants }).map(group => group.constant))
      .toEqual(["14.4", "14.3", "14.2", "14.1", "14.0"]);
  });

  it("respects missing constants and the single-constant level 16", () => {
    const charts = [15.5, 15.6, 15.7, 15.8, 16].map((constant, index) => chart(String(index), { constant }));
    const filters = { ...DEFAULT_CONSTANT_TABLE_FILTERS, level: "15+", constants: ["15.8"] };
    expect(resolveConstantTableSelection(charts, filters, "all")).toEqual(["15.5", "15.6", "15.7", "15.8"]);
    expect(resolveConstantTableSelection(charts, { ...filters, level: "16" }, "all")).toEqual(["16.0"]);
    expect(resolveConstantTableSelection(charts, { ...filters, level: "" }, "all")).toEqual([]);
    expect(resolveConstantTableSelection(charts, { ...filters, level: "16", constants: ["16.0"] }, "single")).toEqual(["16.0"]);
  });

  it("refreshes all-level selection from the active difficulty, genre and version", () => {
    const charts = [chart("a", { constant: 14 }), chart("b", { constant: 14.1 }),
      chart("difficulty", { constant: 14.2, difficulty: "EXP" }), chart("genre", { constant: 14.3, genre: "VARIETY" }),
      chart("version", { constant: 14.4, version: "AIR" })];
    const filters = { ...DEFAULT_CONSTANT_TABLE_FILTERS, level: "14", difficulty: "MAS" as const, genre: "ORIGINAL", version: "MATE" };
    expect(resolveConstantTableSelection(charts, filters, "all")).toEqual(["14.0", "14.1"]);
    expect(resolveConstantTableSelection(charts, { ...filters, difficulty: "EXP" }, "all")).toEqual(["14.2"]);
    expect(resolveConstantTableSelection(charts, { ...filters, genre: "VARIETY" }, "all")).toEqual(["14.3"]);
    expect(resolveConstantTableSelection(charts, { ...filters, version: "AIR" }, "all")).toEqual(["14.4"]);
    expect(resolveConstantTableSelection(charts, { ...filters, genre: "不存在" }, "all")).toEqual([]);
    expect(resolveConstantTableSelection(charts, { ...filters, constants: ["14.0"] }, "single")).toEqual(["14.0"]);
  });

  it("fills a continuous interval in either direction and accepts at most five tenths", () => {
    expect(toggleConstantSelection(["14.0"], "14.3")).toEqual(["14.0", "14.1", "14.2", "14.3"]);
    expect(toggleConstantSelection(["14.4"], "14.0")).toEqual(["14.0", "14.1", "14.2", "14.3", "14.4"]);
    expect(validateConstantSelection(["14.2", "14.0", "14.1", "14.1"])).toEqual(["14.0", "14.1", "14.2"]);
    expect(toggleConstantSelection(["13.8", "13.9"], "14.2")).toEqual(["13.8", "13.9", "14.0", "14.1", "14.2"]);
  });

  it("rejects gaps, oversized ranges and malformed values without changing the selection", () => {
    const selected = ["14.0", "14.1", "14.2", "14.3", "14.4"];
    expect(() => toggleConstantSelection(selected, "14.5")).toThrow("最多选择连续 5 档");
    expect(() => toggleConstantSelection(selected, "14.2")).toThrow("区间两端");
    expect(selected).toEqual(["14.0", "14.1", "14.2", "14.3", "14.4"]);
    expect(() => validateConstantSelection(["14.0", "14.2"])).toThrow("连续");
    expect(() => validateConstantSelection([])).toThrow("至少选择一个");
    for (const value of ["14.00", "NaN", "14", "-1.0"]) expect(() => validateConstantSelection([value])).toThrow("格式无效");
  });

  it("removes only endpoints and allows clearing then starting a new interval", () => {
    expect(toggleConstantSelection(["14.0", "14.1", "14.2"], "14.0")).toEqual(["14.1", "14.2"]);
    expect(toggleConstantSelection(["14.0", "14.1", "14.2"], "14.2")).toEqual(["14.0", "14.1"]);
    expect(toggleConstantSelection(["14.0"], "14.0")).toEqual([]);
    expect(toggleConstantSelection([], "15.0")).toEqual(["15.0"]);
  });

  it("skips the nonexistent 15.9 and allows both available endpoints to be deselected", () => {
    const available = ["15.8", "16.0"];
    const selected = toggleConstantSelection(["15.8"], "16.0", available);
    expect(selected).toEqual(["15.8", "16.0"]);
    expect(validateConstantSelection(selected, available)).toEqual(selected);
    expect(toggleConstantSelection(selected, "15.8", available)).toEqual(["16.0"]);
    expect(toggleConstantSelection(["16.0"], "16.0", available)).toEqual([]);
    expect(toggleConstantSelection(selected, "16.0", available)).toEqual(["15.8"]);
    expect(toggleConstantSelection(["15.8"], "15.8", available)).toEqual([]);
    expect(() => toggleConstantSelection(selected, "15.9", available)).toThrow("没有这个定数");
  });

  it("cleans old hidden values and follows the new available interval without automatically selecting a replacement", () => {
    expect(reconcileConstantSelection(["15.8", "15.9", "16.0"], ["15.8", "16.0"])).toEqual(["15.8", "16.0"]);
    expect(reconcileConstantSelection(["15.9"], ["15.8", "16.0"])).toEqual([]);
    expect(reconcileConstantSelection(["15.8", "16.0"], ["13.0", "13.1"])).toEqual([]);
    expect(reconcileConstantSelection([], ["13.0", "13.1"])).toEqual([]);
    expect(reconcileConstantSelection(["13.1", "13.2", "13.5"], ["13.1", "13.2", "13.5"])).toEqual(["13.1", "13.2", "13.5"]);
    expect(reconcileConstantSelection(["13.1", "13.5"], ["13.1", "13.2", "13.3", "13.4", "13.5"])).toEqual(["13.1", "13.2", "13.3", "13.4", "13.5"]);
  });

  it("still rejects skipped available options and ranges wider than four tenths", () => {
    expect(() => validateConstantSelection(["14.0", "14.2"], ["14.0", "14.1", "14.2"])).toThrow("连续");
    expect(() => validateConstantSelection(["15.5", "16.0"], ["15.5", "16.0"])).toThrow("跨度不超过 0.4");
    expect(() => validateConstantSelection(["15.9"], ["15.8", "16.0"])).toThrow("不存在");
  });
});

describe("constant table groups", () => {
  it("separates constants descending, then orders ULT/MAS/EXP and release dates ascending", () => {
    const charts = [chart("new"), chart("old", { difficulty: "EXP" }), chart("missing"), chart("new", { difficulty: "ULT" }),
      chart("old"), chart("10"), chart("2"), chart("higher", { constant: 14.1 })];
    const before = structuredClone(charts);
    const groups = buildConstantTableGroups(charts, {}, { ...DEFAULT_CONSTANT_TABLE_FILTERS, constants: ["14.0", "14.1"] });
    expect(groups.map(group => group.constant)).toEqual(["14.1", "14.0"]);
    expect(groups[1].entries.map(entry => chartKey(entry.chart))).toEqual(["new:ULT", "2:MAS", "10:MAS", "old:MAS", "new:MAS", "missing:MAS", "old:EXP"]);
    expect(groups[1].entries.find(entry => entry.chart.id === "missing")?.releaseDate).toBeNull();
    expect(charts).toEqual(before);
  });

  it("combines all five filters, preserves unplayed charts, and associates scores by chart key", () => {
    const match = chart("match", { constant: 13.5 });
    const scores = { [chartKey(match)]: record(match, { score: 0 }) };
    const charts = [match, chart("unplayed", { constant: 13.5 }), chart("difficulty", { constant: 13.5, difficulty: "EXP" }),
      chart("level", { constant: 13.4 }), chart("constant", { constant: 13.6 }), chart("genre", { constant: 13.5, genre: "VARIETY" }),
      chart("version", { constant: 13.5, version: "AIR" })];
    const filters = { difficulty: "MAS" as const, level: "13+", constants: ["13.5"], genre: "ORIGINAL", version: "MATE" };
    const groups = buildConstantTableGroups(charts, scores, filters);
    expect(groups[0].entries.map(entry => entry.chart.id)).toEqual(["match", "unplayed"]);
    expect(groups[0].entries[0].record?.score).toBe(0);
    expect(groups[0].entries[1].record).toBeUndefined();
    expect(filters.constants).toEqual(["13.5"]);
  });

  it("does not keep groups that have no available charts under the active filters", () => {
    expect(buildConstantTableGroups([], {}, DEFAULT_CONSTANT_TABLE_FILTERS)).toEqual([]);
    const charts = [chart("a", { difficulty: "ULT", constant: 15.8 }), chart("b", { difficulty: "ULT", constant: 16 })];
    expect(buildConstantTableGroups(charts, {}, { ...DEFAULT_CONSTANT_TABLE_FILTERS, constants: ["15.8", "15.9", "16.0"] })
      .map(group => group.constant)).toEqual(["16.0", "15.8"]);
  });

  it("keeps the four requested achievement groups separate from unplayed charts", () => {
    const data = chart("1");
    expect(constantTableLamp(undefined)).toBe("unplayed");
    expect(constantTableLamp(record(data))).toBe("clear");
    for (const combo of ["fc", "aj", "ajc"] as const) expect(constantTableLamp(record(data, { combo }))).toBe(combo);
  });
});
