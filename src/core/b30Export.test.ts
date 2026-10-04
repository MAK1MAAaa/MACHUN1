import { describe, expect, it } from "vitest";
import type { CatalogChart, SingleRating } from "../types";
import { createB30Export, createOtoB30Export, createB30CandidatesExport } from "./b30Export";

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
