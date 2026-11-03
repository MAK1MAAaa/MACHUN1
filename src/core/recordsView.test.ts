import { describe, expect, it } from "vitest";
import { SCORE_SOURCES, type CatalogChart, type Difficulty, type SingleRating } from "../types";
import { chartKey } from "./b30";
import {
  buildRecordsRows,
  clearUnavailableRecordConstant,
  cycleRecordsSort,
  EMPTY_RECORDS_FILTERS,
  getAvailableChartConstants,
  getRecordsFilterOptions,
  getChartLevel,
  paginateRecords,
  type RecordsFilters,
  type RecordsSort,
} from "./recordsView";

function chart(id: string, overrides: Partial<CatalogChart> = {}): CatalogChart {
  return {
    id, title: `歌曲 ${id}`, difficulty: "MAS", constant: 14.5,
    nickname: [], genre: "ORIGINAL", version: "NEW",
    coverUrl: `https://example.com/${id}.jpg`, bpm: 180,
    notes: { total: 1000, tap: 500, hold: 100, slide: 100, air: 200, flick: 100 },
    ...overrides,
  };
}

function score(chart: CatalogChart, rating: number, overrides: Partial<SingleRating> = {}): SingleRating {
  return {
    id: chart.id, title: chart.title, difficulty: chart.difficulty,
    constant: chart.constant, rating, score: 1_000_000,
    source: "manual", updatedAt: "2026-10-04T00:00:00.000Z", ...overrides,
  };
}

function rows(
  charts: CatalogChart[], records: SingleRating[],
  filters: Partial<RecordsFilters> = {}, aliases: Record<string, string[]> = {},
) {
  return buildRecordsRows(charts, Object.fromEntries(records.map((record) => [chartKey(record), record])), aliases, { ...EMPTY_RECORDS_FILTERS, ...filters });
}

describe("record browsing", () => {

  it("defaults to one descending Rating sort and switches exclusively between the two fields", () => {
    expect(EMPTY_RECORDS_FILTERS.sort).toBe("rating-descending");
    expect(cycleRecordsSort("rating-descending", "rating")).toBe("rating-ascending");
    expect(cycleRecordsSort("rating-ascending", "rating")).toBe("rating-descending");
    expect(cycleRecordsSort("rating-ascending", "score")).toBe("score-descending");
    expect(cycleRecordsSort("score-descending", "score")).toBe("score-ascending");
    expect(cycleRecordsSort("score-ascending", "score")).toBe("score-descending");
    expect(cycleRecordsSort("score-ascending", "rating")).toBe("rating-descending");
  });

  it.each([
    ["rating-descending", ["high-rating", "high-score", "lower-score", "low-rating", "zero", "unplayed"]],
    ["rating-ascending", ["zero", "low-rating", "lower-score", "high-score", "high-rating", "unplayed"]],
    ["score-descending", ["high-score", "lower-score", "low-rating", "high-rating", "zero", "unplayed"]],
    ["score-ascending", ["zero", "high-rating", "low-rating", "lower-score", "high-score", "unplayed"]],
  ] as const)("sorts with %s and breaks ties by the other value in the same direction", (sort, expected) => {
    const charts = ["lower-score", "high-score", "low-rating", "high-rating", "zero", "unplayed"]
      .map((id, index) => chart(id, { constant: 13 + index / 10 }));
    const records = [
      score(charts[0], 17, { score: 1_005_000 }),
      score(charts[1], 17, { score: 1_009_000 }),
      score(charts[2], 16, { score: 1_005_000 }),
      score(charts[3], 18, { score: 1_000_000 }),
      score(charts[4], 0, { score: 0 }),
    ];
    const beforeCharts = structuredClone(charts), beforeRecords = structuredClone(records);
    expect(rows(charts, records, { sort, includeUnplayed: true }).map(row => row.chart.id)).toEqual(expected);
    expect(rows([...charts].reverse(), [...records].reverse(), { sort, includeUnplayed: true }).map(row => row.chart.id)).toEqual(expected);
    expect(charts).toEqual(beforeCharts);
    expect(records).toEqual(beforeRecords);
  });

  it("uses descending constants, title and chart key only after both sortable values tie", () => {
    const charts = [chart("2", { title: "Alpha", constant: 14 }), chart("z", { title: "Zulu", constant: 14 }), chart("high-constant", { constant: 15 }), chart("1", { title: "Alpha", constant: 14 }), chart("unplayed", { constant: 16 })];
    const records = charts.slice(0, -1).map(item => score(item, 0, { score: 0 }));
    for (const sort of ["rating-ascending", "rating-descending", "score-ascending", "score-descending"] as RecordsSort[]) {
      const result = rows(charts, records, { sort, includeUnplayed: true }).map(row => row.chart.id);
      expect(result).toEqual(["high-constant", "1", "2", "z", "unplayed"]);
      expect(rows([...charts].reverse(), [...records].reverse(), { sort, includeUnplayed: true }).map(row => row.chart.id)).toEqual(result);
    }
  });

  it("filters and sorts the full result before taking a page and excludes records outside the catalog", () => {
    const charts = Array.from({ length: 25 }, (_, index) => chart(String(index)));
    const records = charts.map((item, index) => score(item, 18 - index / 100, { score: 1_000_000 + index }));
    records.push(score(chart("removed"), 20, { score: 1_010_000 }));
    const original = structuredClone(records);
    const sorted = rows(charts, [...records].reverse());
    expect(sorted).toHaveLength(25);
    expect(paginateRecords(sorted, 2).rows.map(row => row.chart.id)).toEqual(Array.from({ length: 10 }, (_, index) => String(index + 10)));
    expect(rows(charts, records, { query: "歌曲 24" }).map(row => row.chart.id)).toEqual(["24"]);
    const scoreSorted = rows(charts, records, { sort: "score-descending" });
    expect(paginateRecords(scoreSorted, 2).rows.map(row => row.chart.id)).toEqual(Array.from({ length: 10 }, (_, index) => String(14 - index)));
    expect(records).toEqual(original);
  });

  it("offers only constants that exist under difficulty, level, genre and version without selecting a hidden gap", () => {
    const charts = [
      chart("mas", { constant: 15.7 }),
      chart("ult-low", { difficulty: "ULT", constant: 15.8 }),
      chart("ult-high", { difficulty: "ULT", constant: 16 }),
      chart("ult-genre", { difficulty: "ULT", constant: 15.6, genre: "VARIETY" }),
      chart("ult-version", { difficulty: "ULT", constant: 15.5, version: "AIR" }),
      chart("exp", { difficulty: "EXP", constant: 14.9 }),
    ];
    expect(getAvailableChartConstants(charts, { ...EMPTY_RECORDS_FILTERS, difficulty: "ULT" }))
      .toEqual(["15.5", "15.6", "15.8", "16.0"]);
    const selectedUlt: RecordsFilters = { ...EMPTY_RECORDS_FILTERS, difficulty: "ULT", constant: "15.8", query: "no match", source: "rin" };
    expect(getAvailableChartConstants(charts, selectedUlt)).toEqual(["15.5", "15.6", "15.8", "16.0"]);
    const filters: RecordsFilters = { ...EMPTY_RECORDS_FILTERS, difficulty: "ULT", level: "15+", genre: "ORIGINAL", version: "NEW", constant: "15.9" };
    expect(getAvailableChartConstants(charts, filters)).toEqual(["15.8"]);
    expect(getAvailableChartConstants(charts, { ...filters, constant: "15.8" } as RecordsFilters)).toEqual(["15.8"]);
    expect(getAvailableChartConstants(charts, { ...filters, difficulty: "EXP" })).toEqual([]);
    expect(getAvailableChartConstants(charts, { ...filters, difficulty: "MAS" })).toEqual(["15.7"]);
  });

  it("clears an unavailable constant after any catalog condition changes and preserves valid selections and other filters", () => {
    const charts = [chart("mas", { constant: 15.7 }), chart("exp", { difficulty: "EXP", constant: 14.9 })];
    const filters: RecordsFilters = { ...EMPTY_RECORDS_FILTERS, constant: "15.7", query: "alias", source: "rin", includeUnplayed: true, sort: "score-ascending" };
    expect(clearUnavailableRecordConstant(charts, filters)).toBe(filters);
    expect(clearUnavailableRecordConstant(charts, { ...filters, difficulty: "EXP" })).toEqual({ ...filters, difficulty: "EXP", constant: "" });
    for (const extra of [{ level: "14+" }, { genre: "VARIETY" }, { version: "AIR" }]) {
      expect(clearUnavailableRecordConstant(charts, { ...filters, ...extra })).toEqual({ ...filters, ...extra, constant: "" });
    }
    const cleared = clearUnavailableRecordConstant(charts, { ...filters, difficulty: "EXP" });
    expect(clearUnavailableRecordConstant(charts, { ...cleared, difficulty: "" }).constant).toBe("");
    expect(clearUnavailableRecordConstant(charts, { ...filters, constant: "15.9" }).constant).toBe("");
    expect(filters.constant).toBe("15.7");
  });

  it.each(SCORE_SOURCES)("filters current highest records by source %s, even with unplayed charts enabled", (source) => {
    const charts = [...SCORE_SOURCES.map((item) => chart(item)), chart("unplayed")];
    const records = charts.slice(0, -1).map((item) => score(item, 17, { source: item.id as typeof source }));
    expect(rows(charts, records, { source, includeUnplayed: true }).map((row) => row.chart.id)).toEqual([source]);
    expect(rows(charts, records, { source }).map((row) => row.chart.id)).toEqual([source]);
    expect(rows(charts, records, { includeUnplayed: true })).toHaveLength(6);
  });

  it("combines source selection with the remaining catalog filters and searches", () => {
    const charts = [chart("match", { constant: 13.1, difficulty: "EXP", genre: "POPS & ANIME", version: "AIR" }), chart("different-constant", { constant: 14 })];
    const records = charts.map((item) => score(item, 16, { source: "munet" }));
    expect(rows(charts, records, { source: "munet", constant: "13.1", difficulty: "EXP", genre: "POPS & ANIME", version: "AIR", query: "match" }).map((row) => row.chart.id)).toEqual(["match"]);
    expect(rows(charts, records, { source: "rin", includeUnplayed: true })).toEqual([]);
  });

  it("combines difficulty, precise constant, genre, and version filters", () => {
    const matching = chart("match", { difficulty: "EXP", constant: 14.1, genre: "VARIETY", version: "AIR PLUS" });
    const charts = [matching,
      chart("difficulty", { ...matching, id: "difficulty", difficulty: "MAS" }),
      chart("constant", { ...matching, id: "constant", constant: 14.2 }),
      chart("genre", { ...matching, id: "genre", genre: "ORIGINAL" }),
      chart("version", { ...matching, id: "version", version: "AIR" }),
    ];
    const result = rows(charts, [], { difficulty: "EXP", constant: "14.1", genre: "VARIETY", version: "AIR PLUS", includeUnplayed: true });
    expect(result.map((row) => row.chart.id)).toEqual(["match"]);
  });

  it("groups each integer level separately from its plus level at the x.5 boundary", () => {
    const constants = [13, 13.1, 13.4, 13.5, 13.7, 13.9, 14, 14.4, 14.5, 14.9, 15, 15.9, 16];
    const charts = constants.map((constant) => chart(String(constant), { constant }));
    expect(constants.map(getChartLevel)).toEqual(["13", "13", "13", "13+", "13+", "13+", "14", "14", "14+", "14+", "15", "15+", "16"]);
    expect(rows(charts, [], { level: "13", includeUnplayed: true }).map((row) => row.chart.constant))
      .toEqual([13.4, 13.1, 13]);
    expect(rows(charts, [], { level: "13+", includeUnplayed: true }).map((row) => row.chart.constant))
      .toEqual([13.9, 13.7, 13.5]);
    expect(getRecordsFilterOptions([...charts].reverse()).levels).toEqual(["13", "13+", "14", "14+", "15", "15+", "16"]);
  });

  it("combines display level with precise constant, difficulty, metadata, source and search", () => {
    const charts = [
      chart("target", { difficulty: "EXP", constant: 13.5, genre: "VARIETY", version: "AIR" }),
      chart("other-difficulty", { difficulty: "MAS", constant: 13.5, genre: "VARIETY", version: "AIR" }),
      chart("other-constant", { difficulty: "EXP", constant: 13.6, genre: "VARIETY", version: "AIR" }),
    ];
    const records = charts.map((item) => score(item, 15, { source: "lxns" }));
    const filters = { level: "13+", constant: "13.5", difficulty: "EXP" as const, genre: "VARIETY", version: "AIR", source: "lxns" as const, query: "target" };
    expect(rows(charts, records, filters).map((row) => row.chart.id)).toEqual(["target"]);
    expect(rows(charts, records, { ...filters, level: "13" })).toEqual([]);
    expect(rows(charts, records, { ...filters, source: "munet" })).toEqual([]);
  });

  it("shows no unplayed rows by default, keeps zero scores, and does not fabricate scores when toggled", () => {
    const charts = [chart("played"), chart("unplayed")];
    const records = [score(charts[0], 0, { score: 0 })];
    expect(rows(charts, records).map((row) => row.chart.id)).toEqual(["played"]);
    const all = rows(charts, records, { includeUnplayed: true });
    expect(all).toHaveLength(2);
    expect(all.find((row) => row.chart.id === "unplayed")).toMatchObject({ record: undefined });
    expect(all.find((row) => row.chart.id === "played")?.record?.score).toBe(0);
  });

  it("matches catalog aliases, custom aliases, normalized IDs, difficulties, and score source labels", () => {
    const first = chart("123", { title: "Alpha", nickname: ["内置别名"] });
    const second = chart("456", { title: "Beta", difficulty: "ULT" });
    const charts = [first, second];
    const records = [score(first, 17, { source: "otogame" }), score(second, 18)];
    for (const query of ["内置别名", "自定义别名", "１２３", "大饼", " aLPHa "]) {
      expect(rows(charts, records, { query }, { "123": ["自定义别名"] }).map((row) => row.chart.id)).toEqual(["123"]);
    }
    expect(rows(charts, records, { query: "ult" }).map((row) => row.chart.id)).toEqual(["456"]);
    expect(rows(charts, [], { query: "内置别名", includeUnplayed: true }).map((row) => row.chart.id)).toEqual(["123"]);
  });

  it("treats each difficulty of a song as an independent played or unplayed chart", () => {
    const charts = (["EXP", "MAS", "ULT"] as Difficulty[]).map((difficulty) => chart("song", { difficulty }));
    const records = [score(charts[1], 17)];
    expect(rows(charts, records).map((row) => row.chart.difficulty)).toEqual(["MAS"]);
    const all = rows(charts, records, { includeUnplayed: true });
    expect(all).toHaveLength(3);
    expect(all.filter((row) => row.record !== undefined).map((row) => row.chart.difficulty)).toEqual(["MAS"]);
  });

  it("provides unique catalog metadata and numeric constant options in 0.1 steps", () => {
    const options = getRecordsFilterOptions([
      chart("1", { constant: 15.1 }), chart("2", { constant: 14.9 }),
      chart("3", { constant: 15 }), chart("4", { constant: 15.1, genre: "VARIETY", version: "AIR PLUS" }),
    ]);
    expect(options.constants).toEqual(["14.9", "15.0", "15.1"]);
    expect(options.levels).toEqual(["14+", "15"]);
    expect(options.genres).toEqual(["ORIGINAL", "VARIETY"]);
    expect(options.versions).toEqual(["AIR PLUS", "NEW"]);
  });

  it("orders version options by Japanese game release rather than alphabetically", () => {
    const versions = [
      "CHUNITHM", "PLUS", "AIR", "AIR PLUS", "STAR", "STAR PLUS",
      "AMAZON", "AMAZON PLUS", "CRYSTAL", "CRYSTAL PLUS", "PARADISE", "PARADISE LOST",
      "NEW", "NEW PLUS", "SUN", "SUN PLUS", "LUMINOUS", "LUMINOUS PLUS",
      "VERSE", "X-VERSE", "X-VERSE-X", "MATE",
    ];
    const charts = [...versions].reverse().map((version, index) => chart(String(index), { version }));
    expect(getRecordsFilterOptions(charts).versions).toEqual(versions);
    expect(getRecordsFilterOptions([...charts.slice(8), ...charts.slice(0, 8)]).versions).toEqual(versions);
    expect(charts.map((item) => item.version)).toEqual([...versions].reverse());
  });

  it("places unknown versions last deterministically and preserves exact filtering values", () => {
    const charts = ["Zulu Future", "MATE", "Alpha Future", "New", "AIR", "Alpha Future"]
      .map((version, index) => chart(String(index), { version }));
    const expected = ["AIR", "New", "MATE", "Alpha Future", "Zulu Future"];
    expect(getRecordsFilterOptions(charts).versions).toEqual(expected);
    expect(getRecordsFilterOptions([...charts].reverse()).versions).toEqual(expected);
    expect(rows(charts, [], { version: "New", includeUnplayed: true }).map((row) => row.chart.id)).toEqual(["3"]);
    expect(rows(charts, [], { version: "NEW", includeUnplayed: true })).toEqual([]);
    expect(getRecordsFilterOptions([]).versions).toEqual([]);
  });

  it("clamps out-of-range pages and keeps an empty result at page one", () => {
    const charts = Array.from({ length: 21 }, (_, index) => chart(String(index)));
    const result = rows(charts, [], { includeUnplayed: true });
    expect(paginateRecords(result, 999)).toMatchObject({ page: 3, pageCount: 3, total: 21 });
    expect(paginateRecords(result, 999).rows).toHaveLength(1);
    expect(paginateRecords(result, -3).page).toBe(1);
    expect(paginateRecords(result, Number.NaN).page).toBe(1);
    expect(paginateRecords([], 2)).toEqual({ rows: [], page: 1, pageCount: 1, total: 0 });
  });

});
