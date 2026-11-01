import { describe, expect, it } from "vitest";
import { SCORE_SOURCES, type CatalogChart, type Difficulty, type SingleRating } from "../types";
import { chartKey } from "./b30";
import {
  buildRecordsRows,
  EMPTY_RECORDS_FILTERS,
  getRecordsFilterOptions,
  getChartLevel,
  paginateRecords,
  type RecordsFilters,
  type RecordsViewMode,
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
  charts: CatalogChart[], records: SingleRating[], mode: RecordsViewMode = "catalog",
  filters: Partial<RecordsFilters> = {}, aliases: Record<string, string[]> = {},
) {
  return buildRecordsRows(charts, records, Object.fromEntries(records.map((record) => [chartKey(record), record])), aliases, mode, { ...EMPTY_RECORDS_FILTERS, ...filters });
}

describe("record browsing", () => {
  it("sorts rating records and preserves their global rank through search and pagination", () => {
    const charts = Array.from({ length: 25 }, (_, index) => chart(String(index)));
    const records = charts.map((item, index) => score(item, 18 - index / 100));
    const original = [...records];
    const ranked = rows(charts, [...records].reverse(), "rating");
    const secondPage = paginateRecords(ranked, 2);
    expect(secondPage.rows).toHaveLength(10);
    expect(secondPage.rows[0].rank).toBe(11);
    expect(secondPage.rows.at(-1)?.rank).toBe(20);
    expect(rows(charts, records, "rating", { query: "歌曲 24" })[0].rank).toBe(25);
    expect(records).toEqual(original);
  });

  it("keeps rating mode restricted to played catalog charts regardless of catalog filters", () => {
    const charts = [chart("played"), chart("unplayed")];
    const records = [score(charts[0], 16), score(chart("deleted-from-catalog"), 19)];
    expect(rows(charts, records, "rating", { includeUnplayed: true, difficulty: "ULT", level: "13", genre: "VARIETY", source: "rin", sort: "score-ascending" }).map((row) => row.chart.id)).toEqual(["played"]);
  });

  it.each(SCORE_SOURCES)("filters current highest records by source %s, even with unplayed charts enabled", (source) => {
    const charts = [...SCORE_SOURCES.map((item) => chart(item)), chart("unplayed")];
    const records = charts.slice(0, -1).map((item) => score(item, 17, { source: item.id as typeof source }));
    expect(rows(charts, records, "catalog", { source, includeUnplayed: true }).map((row) => row.chart.id)).toEqual([source]);
    expect(rows(charts, records, "catalog", { source }).map((row) => row.chart.id)).toEqual([source]);
    expect(rows(charts, records, "catalog", { includeUnplayed: true })).toHaveLength(6);
  });

  it("combines source selection with the remaining catalog filters and searches", () => {
    const charts = [chart("match", { constant: 13.1, difficulty: "EXP", genre: "POPS & ANIME", version: "AIR" }), chart("different-constant", { constant: 14 })];
    const records = charts.map((item) => score(item, 16, { source: "munet" }));
    expect(rows(charts, records, "catalog", { source: "munet", constant: "13.1", difficulty: "EXP", genre: "POPS & ANIME", version: "AIR", query: "match" }).map((row) => row.chart.id)).toEqual(["match"]);
    expect(rows(charts, records, "catalog", { source: "rin", includeUnplayed: true })).toEqual([]);
  });

  it("sorts catalog scores in both directions, places unplayed charts last, and keeps a zero score", () => {
    const charts = [chart("zero", { constant: 13 }), chart("high", { constant: 14 }), chart("middle", { constant: 15 }), chart("unplayed", { constant: 16 })];
    const records = [score(charts[0], 0, { score: 0 }), score(charts[1], 14, { score: 1_009_000 }), score(charts[2], 15, { score: 1_000_000 })];
    expect(rows(charts, records, "catalog", { includeUnplayed: true, sort: "score-descending" }).map((row) => row.chart.id)).toEqual(["high", "middle", "zero", "unplayed"]);
    expect(rows(charts, records, "catalog", { includeUnplayed: true, sort: "score-ascending" }).map((row) => row.chart.id)).toEqual(["zero", "middle", "high", "unplayed"]);
    expect(rows(charts, records, "catalog", { includeUnplayed: true, sort: "constant-descending" }).map((row) => row.chart.id)).toEqual(["middle", "high", "zero", "unplayed"]);
    expect(records.map((record) => record.id)).toEqual(["zero", "high", "middle"]);
  });

  it("breaks equal score ties deterministically using constant, title, and chart key", () => {
    const charts = [chart("2", { title: "Alpha", constant: 14 }), chart("z", { title: "Zulu", constant: 14 }), chart("high-constant", { constant: 15 }), chart("1", { title: "Alpha", constant: 14 })];
    const records = charts.map((item) => score(item, 16));
    for (const sort of ["score-ascending", "score-descending"] as const) {
      const result = rows(charts, records, "catalog", { sort }).map((row) => row.chart.id);
      expect(result).toEqual(["high-constant", "1", "2", "z"]);
      expect(rows([...charts].reverse(), [...records].reverse(), "catalog", { sort }).map((row) => row.chart.id)).toEqual(result);
    }
  });

  it.each(["constant-ascending", "constant-descending"] as const)("sorts filtered constants with %s before paginating and leaves unplayed charts last", (sort) => {
    const charts = Array.from({ length: 13 }, (_, index) => chart(String(index), { constant: 13 + index / 10 }));
    const records = charts.slice(0, 12).map((item, index) => score(item, 18 - index / 10));
    const result = rows(charts, records, "catalog", { includeUnplayed: true, difficulty: "MAS", sort });
    const expectedPlayed = sort === "constant-ascending" ? records.map((record) => record.id) : records.map((record) => record.id).reverse();
    expect(result.map((row) => row.chart.id)).toEqual([...expectedPlayed, "12"]);
    expect(paginateRecords(result, 2).rows.map((row) => row.chart.id)).toEqual([...expectedPlayed.slice(10), "12"]);
    expect(rows(charts, records, "catalog", { level: "13+", sort }).map((row) => row.chart.constant))
      .toEqual(sort === "constant-ascending" ? [13.5, 13.6, 13.7, 13.8, 13.9] : [13.9, 13.8, 13.7, 13.6, 13.5]);
  });

  it.each(["rating-ascending", "rating-descending"] as const)("sorts actual Rating with %s, preserving zero ratings and keeping unplayed charts last", (sort) => {
    const charts = [chart("zero", { constant: 16 }), chart("high", { constant: 13 }), chart("middle", { constant: 15 }), chart("unplayed", { constant: 16.5 })];
    const records = [score(charts[0], 0, { score: 0 }), score(charts[1], 17), score(charts[2], 16)];
    const result = rows(charts, records, "catalog", { includeUnplayed: true, sort });
    expect(result.map((row) => row.chart.id)).toEqual(sort === "rating-ascending" ? ["zero", "middle", "high", "unplayed"] : ["high", "middle", "zero", "unplayed"]);
    expect(rows(charts, records, "rating", { sort }).map((row) => row.chart.id)).toEqual(["high", "middle", "zero"]);
    expect(records.map((record) => record.id)).toEqual(["zero", "high", "middle"]);
  });

  it("uses score, constant, title and chart key to resolve equal Ratings deterministically", () => {
    const charts = [chart("low-score", { constant: 15 }), chart("low-constant", { constant: 13 }), chart("high-constant", { constant: 14 })];
    const records = charts.map((item) => score(item, 16, { score: item.id === "low-score" ? 990_000 : 1_000_000 }));
    for (const sort of ["rating-ascending", "rating-descending"] as const) {
      const expected = ["high-constant", "low-constant", "low-score"];
      expect(rows(charts, records, "catalog", { sort }).map((row) => row.chart.id)).toEqual(expected);
      expect(rows([...charts].reverse(), [...records].reverse(), "catalog", { sort }).map((row) => row.chart.id)).toEqual(expected);
    }
  });

  it("keeps Rating mode in rating order after catalog score sorting and source filtering", () => {
    const charts = [chart("first"), chart("second")];
    const records = [score(charts[0], 18, { score: 950_000, source: "rin" }), score(charts[1], 16, { score: 1_010_000, source: "lxns" })];
    expect(rows(charts, records, "rating", { source: "lxns", sort: "score-descending" }).map((row) => row.chart.id)).toEqual(["first", "second"]);
  });

  it("combines difficulty, precise constant, genre, and version filters", () => {
    const matching = chart("match", { difficulty: "EXP", constant: 14.1, genre: "VARIETY", version: "AIR PLUS" });
    const charts = [matching,
      chart("difficulty", { ...matching, id: "difficulty", difficulty: "MAS" }),
      chart("constant", { ...matching, id: "constant", constant: 14.2 }),
      chart("genre", { ...matching, id: "genre", genre: "ORIGINAL" }),
      chart("version", { ...matching, id: "version", version: "AIR" }),
    ];
    const result = rows(charts, [], "catalog", { difficulty: "EXP", constant: "14.1", genre: "VARIETY", version: "AIR PLUS", includeUnplayed: true });
    expect(result.map((row) => row.chart.id)).toEqual(["match"]);
  });

  it("groups each integer level separately from its plus level at the x.5 boundary", () => {
    const constants = [13, 13.1, 13.4, 13.5, 13.7, 13.9, 14, 14.4, 14.5, 14.9, 15, 15.9, 16];
    const charts = constants.map((constant) => chart(String(constant), { constant }));
    expect(constants.map(getChartLevel)).toEqual(["13", "13", "13", "13+", "13+", "13+", "14", "14", "14+", "14+", "15", "15+", "16"]);
    expect(rows(charts, [], "catalog", { level: "13", includeUnplayed: true }).map((row) => row.chart.constant))
      .toEqual([13.4, 13.1, 13]);
    expect(rows(charts, [], "catalog", { level: "13+", includeUnplayed: true }).map((row) => row.chart.constant))
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
    expect(rows(charts, records, "catalog", filters).map((row) => row.chart.id)).toEqual(["target"]);
    expect(rows(charts, records, "catalog", { ...filters, level: "13" })).toEqual([]);
    expect(rows(charts, records, "catalog", { ...filters, source: "munet" })).toEqual([]);
  });

  it("shows no unplayed rows by default, keeps zero scores, and does not fabricate scores when toggled", () => {
    const charts = [chart("played"), chart("unplayed")];
    const records = [score(charts[0], 0, { score: 0 })];
    expect(rows(charts, records).map((row) => row.chart.id)).toEqual(["played"]);
    const all = rows(charts, records, "catalog", { includeUnplayed: true });
    expect(all).toHaveLength(2);
    expect(all.find((row) => row.chart.id === "unplayed")).toMatchObject({ record: undefined, rank: null });
    expect(all.find((row) => row.chart.id === "played")?.record?.score).toBe(0);
  });

  it("matches catalog aliases, custom aliases, normalized IDs, difficulties, and score source labels", () => {
    const first = chart("123", { title: "Alpha", nickname: ["内置别名"] });
    const second = chart("456", { title: "Beta", difficulty: "ULT" });
    const charts = [first, second];
    const records = [score(first, 17, { source: "otogame" }), score(second, 18)];
    for (const query of ["内置别名", "自定义别名", "１２３", "大饼", " aLPHa "]) {
      expect(rows(charts, records, "rating", { query }, { "123": ["自定义别名"] }).map((row) => row.chart.id)).toEqual(["123"]);
    }
    expect(rows(charts, records, "catalog", { query: "ult" }).map((row) => row.chart.id)).toEqual(["456"]);
    expect(rows(charts, [], "catalog", { query: "内置别名", includeUnplayed: true }).map((row) => row.chart.id)).toEqual(["123"]);
  });

  it("treats each difficulty of a song as an independent played or unplayed chart", () => {
    const charts = (["EXP", "MAS", "ULT"] as Difficulty[]).map((difficulty) => chart("song", { difficulty }));
    const records = [score(charts[1], 17)];
    expect(rows(charts, records).map((row) => row.chart.difficulty)).toEqual(["MAS"]);
    const all = rows(charts, records, "catalog", { includeUnplayed: true });
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
    expect(rows(charts, [], "catalog", { version: "New", includeUnplayed: true }).map((row) => row.chart.id)).toEqual(["3"]);
    expect(rows(charts, [], "catalog", { version: "NEW", includeUnplayed: true })).toEqual([]);
    expect(getRecordsFilterOptions([]).versions).toEqual([]);
  });

  it("clamps out-of-range pages and keeps an empty result at page one", () => {
    const charts = Array.from({ length: 21 }, (_, index) => chart(String(index)));
    const result = rows(charts, [], "catalog", { includeUnplayed: true });
    expect(paginateRecords(result, 999)).toMatchObject({ page: 3, pageCount: 3, total: 21 });
    expect(paginateRecords(result, 999).rows).toHaveLength(1);
    expect(paginateRecords(result, -3).page).toBe(1);
    expect(paginateRecords(result, Number.NaN).page).toBe(1);
    expect(paginateRecords([], 2)).toEqual({ rows: [], page: 1, pageCount: 1, total: 0 });
  });

  it("sorts catalog rows by constant rather than score while preserving rating order in the other mode", () => {
    const charts = [chart("lower", { constant: 14 }), chart("higher", { constant: 15 })];
    const records = [score(charts[0], 18), score(charts[1], 16)];
    expect(rows(charts, records).map((row) => row.chart.id)).toEqual(["higher", "lower"]);
    expect(rows(charts, records, "rating").map((row) => row.chart.id)).toEqual(["lower", "higher"]);
  });
});
