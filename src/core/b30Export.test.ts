import { describe, expect, it } from "vitest";
import type { CatalogChart, SingleRating } from "../types";
import { createAjB30Export, createB30Export, createOtoB30Export, createB30CandidatesExport } from "./b30Export";

import { importSourceJson } from "./sources";
import { EMPTY_STATE } from "./storage";
import { calculateRating } from "./rating";

function makeRecord(index: number): SingleRating {
  return {
    id: String(index),
    title: `Song ${index}`,
    difficulty: "MAS",
    constant: 14,
    score: 1_000_000 - index,
    rating: 16 - index / 10,
    updatedAt: "2026-08-03T00:00:00.000Z",
    source: "rin",
  };
}

describe("B30-only export", () => {
  it("exports exactly 30 ranked slots without local aliases or non-B30 scores", () => {
    const records = Array.from({ length: 35 }, (_, index) => makeRecord(index + 1));
    const charts = new Map<string, CatalogChart>(records.map((record) => [
      `${record.id}:${record.difficulty}`,
      {
        id: record.id,
        title: record.title,
        difficulty: record.difficulty,
        constant: record.constant,
        genre: "ORIGINAL",
        version: "AIR PLUS",
        nickname: [`alias-${record.id}`],
        coverUrl: `https://example.com/${record.id}.jpg`,
        bpm: 180,
        notes: { total: 1000, tap: 500, hold: 100, slide: 150, air: 200, flick: 50 },
      },
    ]));

    const exported = createB30Export(records, charts, "Mate-test", "2026-08-03T00:00:00.000Z");
    expect(exported.type).toBe("machun1-b30");
    expect(exported.b30).toHaveLength(30);
    expect(exported.b30[0]).toMatchObject({ rank: 1, id: "1", coverUrl: "https://example.com/1.jpg", source: "rin" });
    expect(exported.b30[29]).toMatchObject({ rank: 30, id: "30" });
    expect(exported.summary.filled).toBe(30);
    expect(exported.summary).not.toHaveProperty("total");
    expect(exported).not.toHaveProperty("scores");
    expect(exported).not.toHaveProperty("nicknameOverrides");
    expect(exported.b30[0]).not.toHaveProperty("updatedAt");
    expect(exported.b30[0]).not.toHaveProperty("nickname");
  });

  it("retains null slots and keeps the average divisor fixed at 30", () => {
    const record = makeRecord(1);
    const chart: CatalogChart = {
      id: record.id,
      title: record.title,
      difficulty: record.difficulty,
      constant: record.constant,
      genre: "ORIGINAL",
      version: "AIR PLUS",
      nickname: [],
      coverUrl: "https://example.com/1.jpg",
      bpm: 180,
      notes: { total: 1000, tap: 500, hold: 100, slide: 150, air: 200, flick: 50 },
    };
    const exported = createB30Export(
      [record],
      new Map([[`${record.id}:${record.difficulty}`, chart]]),
      "Mate-test",
    );

    expect(exported.b30.filter(Boolean)).toHaveLength(1);
    expect(exported.b30.slice(1).every((slot) => slot === null)).toBe(true);
    expect(exported.summary.average).toBe(record.rating / 30);
  });
});

describe("AJ B30 export", () => {
  it("includes only explicit AJ and AJC lamps while preserving score metadata", () => {
    const aj: SingleRating = { ...makeRecord(1), combo: "aj", fullChain: "gold", source: "munet" };
    const ajc: SingleRating = { ...makeRecord(2), combo: "ajc", fullChain: "platinum", source: "lxns" };
    const records: SingleRating[] = [
      { ...makeRecord(3), score: 1_010_000, rating: 19 },
      { ...makeRecord(4), score: 1_009_999, rating: 18, combo: "fc" },
      { ...makeRecord(5), rating: 17, fullChain: "platinum" },
      ajc,
      aj,
    ];
    const chart: CatalogChart = {
      ...aj,
      genre: "ORIGINAL",
      version: "AIR PLUS",
      nickname: ["private alias"],
      coverUrl: "https://example.com/aj.jpg",
      bpm: null,
      notes: { total: 100, tap: 100, hold: 0, slide: 0, air: 0, flick: 0 },
    };
    const exported = createAjB30Export(records, new Map([["1:MAS", chart]]), "Mate-test", "2026-10-17T00:00:00Z");

    expect(exported).toMatchObject({
      schemaVersion: 3,
      type: "machun1-aj-b30",
      catalogVersion: "Mate-test",
      exportedAt: "2026-10-17T00:00:00Z",
      summary: { filled: 2, average: (aj.rating + ajc.rating) / 30 },
    });
    expect(exported.b30.slice(0, 2)).toEqual([
      { rank: 1, id: "1", title: aj.title, difficulty: "MAS", constant: aj.constant, score: aj.score,
        rating: aj.rating, coverUrl: chart.coverUrl, source: "munet", combo: "aj", fullChain: "gold" },
      { rank: 2, id: "2", title: ajc.title, difficulty: "MAS", constant: ajc.constant, score: ajc.score,
        rating: ajc.rating, coverUrl: "", source: "lxns", combo: "ajc", fullChain: "platinum" },
    ]);
    expect(exported.b30[0]).not.toHaveProperty("nickname");
  });

  it("filters before ranking and keeps the best 30 AJ charts without mutating inputs", () => {
    const eligible: SingleRating[] = Array.from({ length: 35 }, (_, index) => ({ ...makeRecord(index + 1), combo: "aj" }));
    const ineligible = Array.from({ length: 35 }, (_, index) => ({ ...makeRecord(index + 100), rating: 25 }));
    const records = Object.freeze([...ineligible, ...eligible].reverse().map((record) => Object.freeze(record)));
    const before = JSON.stringify(records);
    const exported = createAjB30Export(records.values(), new Map(), "test");

    expect(exported.summary.filled).toBe(30);
    expect(exported.b30.map((slot) => slot?.id)).toEqual(Array.from({ length: 30 }, (_, index) => String(index + 1)));
    expect(exported.b30.map((slot) => slot?.rank)).toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
    expect(exported.summary.average).toBe(eligible.slice(0, 30).reduce((sum, record) => sum + record.rating, 0) / 30);
    expect(JSON.stringify(records)).toBe(before);
  });

  it("uses the ordinary B30 score and constant tie breakers", () => {
    const records: SingleRating[] = [
      { ...makeRecord(1), combo: "aj", rating: 16, score: 1_009_000, constant: 14.0 },
      { ...makeRecord(2), combo: "ajc", rating: 16, score: 1_010_000, constant: 13.5 },
      { ...makeRecord(3), combo: "aj", rating: 16, score: 1_009_000, constant: 14.1 },
    ];
    expect(createAjB30Export(records, new Map(), "test").b30.slice(0, 3).map((slot) => slot?.id)).toEqual(["2", "3", "1"]);
  });

  it("pads partial and empty AJ lists to 30 slots with a fixed average divisor", () => {
    const record: SingleRating = { ...makeRecord(1), combo: "aj" };
    const partial = createAjB30Export([record, makeRecord(2)], new Map(), "test");
    expect(partial.b30).toHaveLength(30);
    expect(partial.summary).toEqual({ filled: 1, average: record.rating / 30 });
    expect(partial.b30.slice(1).every((slot) => slot === null)).toBe(true);
    for (const scores of [[], [makeRecord(2)]]) {
      const empty = createAjB30Export(scores, new Map(), "test");
      expect(empty.summary).toEqual({ filled: 0, average: 0 });
      expect(empty.b30).toEqual(Array(30).fill(null));
    }
  });
});

describe("OTO-compatible B30 JSON", () => {
  it("exports only the top 30 and round-trips through the Otogame importer", () => {
    const records = Array.from({ length: 35 }, (_, index): SingleRating => {
      const difficulty = (["EXP", "MAS", "ULT"] as const)[index % 3];
      const record = { ...makeRecord(index + 1), difficulty };
      return { ...record, rating: calculateRating(record.score, record.constant) };
    });
    const charts = new Map<string, CatalogChart>(records.map((record) => [
      `${record.id}:${record.difficulty}`,
      { ...record, genre: "ORIGINAL", version: "AIR PLUS", nickname: [], coverUrl: "https://example.com/a.jpg", bpm: 180,
        notes: { total: 100, tap: 100, hold: 0, slide: 0, air: 0, flick: 0 } },
    ]));
    const data = createOtoB30Export([...records].reverse());
    expect(data.data.base_rating_list).toHaveLength(30);
    expect(data.data.base_rating_list[0]).toEqual({ song_id: "1", difficulty: 2, music: { name: "Song 1" }, score: 999999 });
    expect(data.data.base_rating_list[29].song_id).toBe("30");
    expect(data.data.new_rating_list).toEqual([]);
    expect(data.data.next_rating_list).toEqual([]);
    expect(data.data.new_next_rating_list).toEqual([]);
    const result = importSourceJson(JSON.stringify(data), "otogame", EMPTY_STATE, charts);
    expect(result.report.importedScores).toBe(30);
    expect(Object.values(result.state.scores).map(({ id, difficulty, score, rating }) => ({ id, difficulty, score, rating })))
      .toEqual(records.slice(0, 30).map(({ id, difficulty, score, rating }) => ({ id, difficulty, score, rating })));
  });

  it("omits empty slots for partial or empty B30 lists", () => {
    expect(createOtoB30Export([]).data.base_rating_list).toEqual([]);
    expect(createOtoB30Export([makeRecord(1)]).data.base_rating_list).toHaveLength(1);
  });

  it("exports ranks 31–50 as OTO candidates and imports all 50 scores", () => {
    const records = Array.from({ length: 55 }, (_, index) => makeRecord(index + 1));
    const exported = createOtoB30Export([...records].reverse(), true);
    expect(exported.data.base_rating_list).toEqual(createOtoB30Export(records).data.base_rating_list);
    expect(exported.data.next_rating_list.map((record) => record.song_id))
      .toEqual(records.slice(30, 50).map((record) => record.id));
    expect(exported.data.new_rating_list).toEqual([]);
    expect(exported.data.new_next_rating_list).toEqual([]);
    const charts = new Map<string, CatalogChart>(records.map((record) => [
      `${record.id}:${record.difficulty}`,
      { ...record, genre: "ORIGINAL", version: "AIR PLUS", nickname: [], coverUrl: "", bpm: null,
        notes: { total: 100, tap: 100, hold: 0, slide: 0, air: 0, flick: 0 } },
    ]));
    const result = importSourceJson(JSON.stringify(exported), "otogame", EMPTY_STATE, charts);
    expect(result.report.importedScores).toBe(50);
    expect(Object.values(result.state.scores).map(({ id, score }) => ({ id, score })))
      .toEqual(records.slice(0, 50).map(({ id, score }) => ({ id, score })));
    expect(createOtoB30Export(records.slice(0, 32), true).data.next_rating_list).toHaveLength(2);
    expect(createOtoB30Export(records.slice(0, 1), true).data.next_rating_list).toEqual([]);
    expect(createOtoB30Export([], true).data.base_rating_list).toEqual([]);
    expect(createOtoB30Export([], true).data.next_rating_list).toEqual([]);
  });
});


describe("B30 plus 20 candidates", () => {
  it("selects ranks 31–50 and excludes candidates from the header average", () => {
    const records = Array.from({ length: 55 }, (_, index) => makeRecord(index + 1));
    const exported = createB30CandidatesExport([...records].reverse(), new Map(), "test");
    expect(exported.b30).toHaveLength(30);
    expect(exported.candidates).toHaveLength(20);
    expect(exported.b30[29]).toMatchObject({ id: "30", rank: 30 });
    expect(exported.candidates[0]).toMatchObject({ id: "31", rank: 31 });
    expect(exported.candidates[19]).toMatchObject({ id: "50", rank: 50 });
    expect(exported.summary).toEqual(createB30Export(records, new Map(), "test").summary);
    expect(new Set([...exported.b30, ...exported.candidates].map((slot) => slot?.id)).size).toBe(50);
  });

  it("pads missing candidates and B30 slots without changing the divisor", () => {
    const records = Array.from({ length: 32 }, (_, index) => makeRecord(index + 1));
    const data = createB30CandidatesExport(records, new Map(), "test");
    expect(data.candidates.filter(Boolean)).toHaveLength(2);
    expect(data.candidates.slice(2).every((slot) => slot === null)).toBe(true);
    const partial = createB30CandidatesExport(records.slice(0, 1), new Map(), "test");
    expect(partial.summary.average).toBe(records[0].rating / 30);
    expect(partial.candidates.every((slot) => slot === null)).toBe(true);
    const empty = createB30CandidatesExport([], new Map(), "test");
    expect(empty.summary.average).toBe(0);
    expect([...empty.b30, ...empty.candidates].every((slot) => slot === null)).toBe(true);
  });
});
