import { describe, expect, it } from "vitest";
import { catalog, catalogByKey, CATALOG_DATE, CATALOG_VERSION, validateCatalog } from "./catalog";
import detailData from "../data/song-chart-details.json";
import sources from "../data/catalog-sources.json";

describe("Mate catalog snapshot", () => {
  it("contains only unique 13.0+ EXP/MAS/ULT charts", () => {
    expect(catalog).toHaveLength(1522);
    const keys = new Set(catalog.map((chart) => `${chart.id}:${chart.difficulty}`));
    expect(keys.size).toBe(catalog.length);
    expect(catalog.every((chart) => chart.constant >= 13)).toBe(true);
    expect(catalog.every((chart) => ["EXP", "MAS", "ULT"].includes(chart.difficulty))).toBe(true);
    expect(catalog.every((chart) => /^https:\/\/otoge-db\.net\/chunithm\/jacket\/.+\.jpg$/.test(chart.coverUrl))).toBe(true);
    expect(catalog.every((chart) => (chart.bpm === null || chart.bpm > 0) && chart.notes.total >= 0)).toBe(true);
    expect(catalog.every((chart) => [chart.notes.tap, chart.notes.hold, chart.notes.slide, chart.notes.air, chart.notes.flick].every(Number.isInteger))).toBe(true);
  });

  it("extends the existing snapshot with the full 13.0–13.9 range", () => {
    expect(CATALOG_VERSION).toBe("Mate-2026-11-01-13plus");
    expect(catalog.slice(0, 823).every((chart) => chart.constant >= 14)).toBe(true);
    const additions = catalog.slice(823, 1498);
    expect(additions).toHaveLength(675);
    expect(additions.every((chart) => chart.constant >= 13 && chart.constant < 14)).toBe(true);
    expect(new Set(additions.map((chart) => chart.constant))).toEqual(new Set([
      13, 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8, 13.9,
    ]));
    expect(additions.every((chart) => chart.bpm !== null && chart.bpm > 0)).toBe(true);
    expect(new Set(catalog.map((chart) => chart.id)).size).toBe(1255);
    // September 25 charts are now included in the October 8 snapshot.
    expect(catalogByKey.has("3058:MAS")).toBe(true);
    expect(catalogByKey.has("3059:MAS")).toBe(true);
  });

  it("adds lower difficulties for existing songs and supplements verified missing notes", () => {
    expect(catalogByKey.get("3043:EXP")).toMatchObject({
      title: "Prismatic Theory",
      constant: 13.4,
      bpm: 148,
      notes: { total: 1433, tap: 732, hold: 111, slide: 431, air: 159, flick: 0 },
    });
    expect(catalogByKey.get("3043:MAS")).toMatchObject({ constant: 14.6, bpm: 148, notes: { total: 1881 } });
    expect(catalogByKey.get("3050:MAS")).toMatchObject({ constant: 13.1, bpm: 180 });
  });

  it("keeps September 25 songs, the new ULT and October 8 photo constants with confirmed updated metadata", () => {
    for (const [id, constant] of [["3058", 13.9], ["3057", 14.6], ["3059", 13.4], ["3052", 13.1], ["3054", 13], ["3055", 15.1], ["3064", 14.1], ["3062", 14.7]] as const) {
      expect(catalogByKey.get(`${id}:MAS`)).toMatchObject({ id, difficulty: "MAS", constant, version: "MATE" });
    }
    expect(catalogByKey.get("2317:ULT")).toMatchObject({ constant: 15, version: "SUN", nickname: catalogByKey.get("2317:MAS")?.nickname });
    expect(catalogByKey.get("3055:MAS")).toMatchObject({ bpm: 168, notes: { total: 2281 } });
    expect(catalogByKey.has("3055:EXP")).toBe(false);
  });

  it("adds all October 22 and 29 scoring charts including the existing song's new ULT", () => {
    const expected = [
      ["2175", "ULT", 14.5],
      ["3065", "MAS", 13.1], ["3066", "MAS", 13.3], ["3067", "MAS", 13.9], ["3068", "MAS", 14.1],
      ["3069", "EXP", 13.5], ["3069", "MAS", 15.2], ["3070", "MAS", 13], ["3071", "MAS", 14.4],
      ["3072", "MAS", 14.2], ["3073", "EXP", 13.3], ["3073", "MAS", 15],
      ["3074", "EXP", 13.6], ["3074", "MAS", 14.9], ["3075", "MAS", 14.2],
    ] as const;
    for (const [id, difficulty, constant] of expected) {
      expect(catalogByKey.get(`${id}:${difficulty}`)).toMatchObject({ id, difficulty, constant });
    }
    expect(catalogByKey.get("2175:ULT")).toMatchObject({ title: "シル・ヴ・プレジデント", version: "NEW PLUS", bpm: 176 });
    expect(catalogByKey.get("3074:MAS")).toMatchObject({ title: "Metaverse Do Be Like This", version: "MATE", genre: "VARIETY", bpm: 180 });
    expect(catalogByKey.get("3069:MAS")).toMatchObject({ bpm: null, notes: { total: 2452 } });
    expect(catalogByKey.get("3071:MAS")).toMatchObject({ bpm: null, notes: { total: 0 } });
  });

  it("keeps confirmed lower difficulties in details and records the reproducible source snapshot", () => {
    expect(detailData).toHaveLength(384);
    expect(detailData).toContainEqual({ id: "2175", difficulty: "MAS", constant: 12.6 });
    expect(detailData).toContainEqual({ id: "3065", difficulty: "EXP", constant: 10.2 });
    expect(detailData).toContainEqual({ id: "3075", difficulty: "EXP", constant: 11.3 });
    expect(new Set(detailData.map(chart => `${chart.id}:${chart.difficulty}`)).size).toBe(detailData.length);
    expect(detailData.every(chart => chart.constant < 13 && !catalogByKey.has(`${chart.id}:${chart.difficulty}`))).toBe(true);
    expect(sources.date).toBe(CATALOG_DATE);
    expect(sources.upstreamCommit).toBe("a5b5b3be40659adb16f9aae7079a483946cbfc99");
  });

  it("provides the same remote cover URL for every chart of a song", () => {
    const coversBySong = new Map<string, string>();
    for (const chart of catalog) {
      const expected = coversBySong.get(chart.id);
      if (expected) expect(chart.coverUrl).toBe(expected);
      else coversBySong.set(chart.id, chart.coverUrl);
    }
    expect(coversBySong.size).toBe(1255);
  });

  it("contains normalized alias lists shared by every chart of a song", () => {
    const aliasesBySong = new Map<string, string[]>();
    for (const chart of catalog) {
      const expected = aliasesBySong.get(chart.id);
      if (expected) {
        expect(chart.nickname).toEqual(expected);
      } else {
        aliasesBySong.set(chart.id, chart.nickname);
      }

      expect(chart.nickname.every((alias) => alias === alias.normalize("NFKC").trim() && alias.length > 0)).toBe(true);
      expect(new Set(chart.nickname.map((alias) => alias.toLocaleLowerCase())).size).toBe(chart.nickname.length);
    }

    const populated = [...aliasesBySong.values()].filter((aliases) => aliases.length > 0);
    const aliasCount = populated.reduce((total, aliases) => total + aliases.length, 0);
    expect(populated.length).toBeGreaterThan(450);
    expect(aliasCount).toBeGreaterThan(900);
  });

  it("provides a known genre and song debut version shared by every difficulty", () => {
    const metadataBySong = new Map<string, { genre: string; version: string }>();
    for (const chart of catalog) {
      expect(chart.genre.length).toBeGreaterThan(0);
      expect(chart.version.length).toBeGreaterThan(0);
      expect(chart.genre).not.toBe("Unknown");
      expect(chart.version).not.toBe("Unknown");
      const metadata = { genre: chart.genre, version: chart.version };
      const expected = metadataBySong.get(chart.id);
      if (expected) expect(metadata).toEqual(expected);
      else metadataBySong.set(chart.id, metadata);
    }
    expect(new Set(catalog.map((chart) => chart.genre))).toEqual(new Set([
      "POPS & ANIME", "niconico", "東方Project", "VARIETY", "イロドリミドリ", "ゲキマイ", "ORIGINAL",
    ]));
    expect(catalogByKey.get("3046:MAS")).toMatchObject({ genre: "ORIGINAL", version: "MATE" });
  });

  it("uses the confirmed X-VERSE-X debut version for the three Linked VERSE songs", () => {
    for (const [id, title] of [["2967", "YOUNITHM"], ["2999", "Melodiniq"], ["3000", "Linked Tune"]]) {
      const charts = catalog.filter(chart => chart.id === id);
      expect(charts.length).toBeGreaterThan(0);
      expect(charts.every(chart => chart.title === title && chart.version === "X-VERSE-X")).toBe(true);
    }
    expect(sources.versionAudit).toMatchObject({ comparedCharts: catalog.length, comparedSongs: 1255, remainingDifferences: 0 });
  });

  it("includes all five 2026-09-17 standard charts at their published constants", () => {
    const expected = [
      ["3044", "Knockout Ravebox", 14.1],
      ["3043", "Prismatic Theory", 14.6],
      ["3045", "アンサレステラー", 14.5],
      ["3086", "Colossus", 14.2],
      ["3046", "[IMPERIALDISORDER]", 15.3],
    ] as const;
    for (const [id, title, constant] of expected) {
      expect(catalogByKey.get(`${id}:MAS`)).toMatchObject({ id, title, constant, difficulty: "MAS" });
    }
    expect(catalogByKey.get("3043:MAS")?.bpm).toBe(148);
  });

  it("rejects invalid and duplicate chart data", () => {
    expect(() => validateCatalog([{ id: "1", title: "A", difficulty: "MAS", constant: 13.9, nickname: [], coverUrl: "http://invalid" }])).toThrow();
    const duplicate = {
      id: "1",
      title: "A",
      difficulty: "MAS",
      constant: 14,
      genre: "ORIGINAL",
      version: "AIR PLUS",
      nickname: [],
      coverUrl: "https://example.com/a.jpg",
      bpm: 180,
      notes: { total: 1000, tap: 500, hold: 100, slide: 150, air: 200, flick: 50 },
    };
    expect(() => validateCatalog([duplicate, duplicate])).toThrow("重复谱面");
    expect(validateCatalog([{ ...duplicate, constant: 13 }])).toHaveLength(1);
    expect(validateCatalog([{ ...duplicate, constant: 13.9 }])).toHaveLength(1);
    expect(() => validateCatalog([{ ...duplicate, constant: 12.9 }])).toThrow("无效谱面");
    expect(() => validateCatalog([{ ...duplicate, genre: " " }])).toThrow("无效谱面");
    expect(() => validateCatalog([{ ...duplicate, version: "" }])).toThrow("无效谱面");
  });
});
