import { describe, expect, it } from "vitest";
import type { CatalogChart, SingleRating } from "../types";
import { chartKey } from "./b30";
import { createB50Export } from "./b30Export";
import { catalog as currentCatalog } from "./catalog";
import { getChartReleaseDate } from "./chartReleaseDates";

function record(id: string, rating = 16): SingleRating {
  return { id, title: `Song ${id}`, difficulty: "MAS", constant: 14, score: 1_009_000,
    rating, updatedAt: "2026-11-02T00:00:00Z", source: "rin" };
}

function chart(score: SingleRating, version: string): CatalogChart {
  return { ...score, genre: "ORIGINAL", version, nickname: ["private alias"],
    coverUrl: `https://example.com/${score.id}.jpg`, bpm: null,
    notes: { total: 0, tap: 0, hold: 0, slide: 0, air: 0, flick: 0 } };
}

function catalog(records: SingleRating[], version: string): Map<string, CatalogChart> {
  return new Map(records.map(score => [chartKey(score), chart(score, version)]));
}

describe("MATE B50 export", () => {
  it("ranks OLD 30 and NEW 20 independently using chart versions and fixed divisors", () => {
    const old = Array.from({ length: 35 }, (_, index) => record(`old-${index}`, 19 - index / 100));
    const fresh = Array.from({ length: 25 }, (_, index) => record(`new-${index}`, 14 - index / 100));
    const charts = new Map([...catalog(old, "X-VERSE-X"), ...catalog(fresh, "MATE")]);
    const data = createB50Export([...fresh, ...old].reverse(), charts, "test", "2026-11-02T00:00:00Z");

    expect(data).toMatchObject({ schemaVersion: 3, type: "machun1-b50", catalogVersion: "test", exportedAt: "2026-11-02T00:00:00Z" });
    expect(data.old30.map(slot => slot?.id)).toEqual(old.slice(0, 30).map(score => score.id));
    expect(data.new20.map(slot => slot?.id)).toEqual(fresh.slice(0, 20).map(score => score.id));
    expect(data.old30.map(slot => slot?.rank)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(data.new20.map(slot => slot?.rank)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const oldTotal = old.slice(0, 30).reduce((sum, score) => sum + score.rating, 0);
    const newTotal = fresh.slice(0, 20).reduce((sum, score) => sum + score.rating, 0);
    expect(data.summary).toEqual({ filled: 50, oldFilled: 30, newFilled: 20,
      average: (oldTotal + newTotal) / 50, oldAverage: oldTotal / 30, newAverage: newTotal / 20 });
    expect(data.old30[0]).not.toHaveProperty("nickname");
    expect(data.old30[0]).not.toHaveProperty("updatedAt");
  });

  it("does not borrow spare group slots and counts missing scores as zero", () => {
    const old = Array.from({ length: 40 }, (_, i) => record(`old-${i}`, 16));
    const fresh = [record("new", 15)];
    const data = createB50Export([...old, ...fresh], new Map([...catalog(old, "AIR"), ...catalog(fresh, "MATE")]), "test");
    expect(data.old30.filter(Boolean)).toHaveLength(30);
    expect(data.new20.filter(Boolean)).toHaveLength(1);
    expect(data.new20.slice(1)).toEqual(Array(19).fill(null));
    expect(data.summary).toEqual({ filled: 31, oldFilled: 30, newFilled: 1,
      average: (30 * 16 + 15) / 50, oldAverage: 16, newAverage: 15 / 20 });
    const empty = createB50Export([], new Map(), "test");
    expect(empty.old30).toEqual(Array(30).fill(null));
    expect(empty.new20).toEqual(Array(20).fill(null));
    expect(empty.summary).toEqual({ filled: 0, oldFilled: 0, newFilled: 0, average: 0, oldAverage: 0, newAverage: 0 });
  });

  it("excludes missing charts, unknown versions and future versions rather than treating them as OLD", () => {
    const records = ["missing", "unknown", "empty", "future", "old", "new"].map(id => record(id));
    const charts = new Map([
      [chartKey(records[1]), chart(records[1], "Unknown")],
      [chartKey(records[2]), chart(records[2], "")],
      [chartKey(records[3]), chart(records[3], "MATE PLUS")],
      [chartKey(records[4]), chart(records[4], "CHUNITHM")],
      [chartKey(records[5]), chart(records[5], " mate ")],
    ]);
    const data = createB50Export(records, charts, "test");
    expect(data.summary.filled).toBe(2);
    expect(data.old30[0]?.id).toBe("old");
    expect(data.new20[0]?.id).toBe("new");
  });

  it("keeps an old song's later-added ULT in OLD using its canonical song version", () => {
    const master = record("same-song");
    const ultima: SingleRating = { ...master, difficulty: "ULT", rating: 17 };
    const data = createB50Export([master, ultima], new Map([
      [chartKey(master), chart(master, "VERSE")], [chartKey(ultima), chart(ultima, "VERSE")],
    ]), "test");
    expect(data.old30.slice(0, 2).map(slot => slot?.difficulty)).toEqual(["ULT", "MAS"]);
    expect(data.new20.every(slot => slot === null)).toBe(true);
  });

  it("classifies recent ULT additions to existing songs as OLD rather than by chart release date", () => {
    const charts = currentCatalog.filter(item => item.difficulty === "ULT" && ["2175", "2317"].includes(item.id));
    expect(charts).toHaveLength(2);
    expect(charts.map(item => getChartReleaseDate(item)).sort()).toEqual(["2026-09-25", "2026-10-22"]);
    const records = charts.map(item => ({ ...record(item.id), title: item.title, difficulty: item.difficulty, constant: item.constant }));
    const data = createB50Export(records, new Map(charts.map(item => [chartKey(item), item])), "test");
    expect(data.summary.oldFilled).toBe(2);
    expect(data.summary.newFilled).toBe(0);
    expect(data.old30.slice(0, 2).map(slot => slot?.id).sort()).toEqual(["2175", "2317"]);
  });

  it("keeps ordinary tie breakers, source and achievement lamps without mutating input", () => {
    const records: SingleRating[] = [
      { ...record("low"), constant: 14.0, source: "munet", combo: "fc", clear: "hard" },
      { ...record("constant"), constant: 14.1, source: "lxns", combo: "aj", fullChain: "gold" },
      { ...record("score"), score: 1_010_000, source: "otogame", combo: "ajc", clear: "absolute" },
    ];
    const frozen = records.map(score => Object.freeze(score));
    const before = JSON.stringify(frozen);
    const data = createB50Export(frozen.values(), catalog(records, "MATE"), "test");
    expect(data.new20.slice(0, 3).map(slot => slot?.id)).toEqual(["score", "constant", "low"]);
    expect(data.new20[0]).toMatchObject({ source: "otogame", combo: "ajc", clear: "absolute" });
    expect(data.new20[1]).toMatchObject({ source: "lxns", combo: "aj", fullChain: "gold" });
    expect(data.new20[2]).toMatchObject({ source: "munet", combo: "fc", clear: "hard" });
    expect(JSON.stringify(frozen)).toBe(before);
  });

  it("counts a chart once while merging historical lamps into its highest score", () => {
    const best = { ...record("duplicate", 17), source: "rin" as const };
    const lower = { ...best, score: 1_000_000, rating: 16, source: "munet" as const,
      combo: "aj" as const, fullChain: "gold" as const, clear: "absolute" as const };
    const data = createB50Export([lower, best, lower], catalog([best], "MATE"), "test");
    expect(data.summary.filled).toBe(1);
    expect(data.new20[0]).toMatchObject({ score: best.score, rating: 17, source: "rin",
      combo: "aj", fullChain: "gold", clear: "absolute" });
    expect(data.summary.average).toBe(17 / 50);
  });
});
