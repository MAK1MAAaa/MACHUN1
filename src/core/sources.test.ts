import { describe, expect, it, vi } from "vitest";
import type { CatalogChart } from "../types";
import { EMPTY_STATE, parseLocalState } from "./storage";
import { createB30Export } from "./b30Export";
import { fetchLxnsScores, importSourceFile, importSourceJson, importSourcePayload, type ExternalScoreSource } from "./sources";

const charts: CatalogChart[] = [
  { id: "100", title: "Master Song", difficulty: "MAS", constant: 14.3, genre: "ORIGINAL", version: "AIR PLUS", nickname: [], coverUrl: "https://example.com/cover.jpg", bpm: 180, notes: { total: 1000, tap: 500, hold: 100, slide: 150, air: 200, flick: 50 } },
  { id: "100", title: "Master Song", difficulty: "ULT", constant: 15.0, genre: "ORIGINAL", version: "AIR PLUS", nickname: [], coverUrl: "https://example.com/cover.jpg", bpm: 190, notes: { total: 1200, tap: 600, hold: 100, slide: 180, air: 250, flick: 70 } },
  { id: "200", title: "Expert Song", difficulty: "EXP", constant: 14.0, genre: "ORIGINAL", version: "AIR PLUS", nickname: [], coverUrl: "https://example.com/cover.jpg", bpm: 170, notes: { total: 900, tap: 450, hold: 100, slide: 100, air: 200, flick: 50 } },
];
const chartMap = new Map(charts.map((chart) => [`${chart.id}:${chart.difficulty}`, chart]));
const lowerCharts: CatalogChart[] = [
  { ...charts[2], id: "300", title: "13.0 Expert Song", constant: 13.0 },
  { ...charts[0], id: "301", title: "13.9 Master Song", constant: 13.9 },
];
const expandedChartMap = new Map([...charts, ...lowerCharts].map((chart) => [`${chart.id}:${chart.difficulty}`, chart]));

function lowerScorePayload(source: ExternalScoreSource, score = 1_005_000): unknown {
  if (source === "munet") return { gameId: "SDHD", userMusicDetailList: [
    { musicId: 300, level: 2, scoreMax: score },
    { musicId: 301, level: 3, scoreMax: score },
    { musicId: 302, level: 3, scoreMax: score },
  ] };
  if (source === "rin") return { userMusicDetailList: [
    { musicId: 300, level: 2, scoreMax: score },
    { musicId: 301, level: 3, scoreMax: score },
    { musicId: 302, level: 3, scoreMax: score },
  ] };
  if (source === "lxns") return { success: true, data: [
    { id: 300, level_index: 2, score },
    { id: 301, level_index: 3, score },
    { id: 302, level_index: 3, score },
  ] };
  return { code: "ok", data: { records: [
    { music: { name: "13.0 Expert Song" }, difficulty: 2, score },
    { music: { name: "13.9 Master Song" }, difficulty: 3, score },
    // A 12.9 chart is deliberately absent from the eligible catalog.
    { music: { name: "12.9 Master Song" }, difficulty: 3, score },
  ] } };
}

describe("external score sources", () => {
  it.each([1_000_000, 1_005_000, 1_009_000])("explicit national-server repair replaces matching MuNET scores with %i", (score) => {
    const current = importSourcePayload({ userMusicDetailList: [
      { musicId: 100, level: 3, scoreMax: 1_005_000 },
      { musicId: 100, level: 4, scoreMax: 1_009_000 },
    ] }, "munet", EMPTY_STATE, chartMap).state;
    current.nicknameOverrides["100"] = ["保留别名"];
    const before = structuredClone(current);
    const payload = [{ id: 100, level_index: 3, score }];
    const repaired = importSourcePayload(payload, "lxns", current, chartMap, "2026-10-04T00:00:00.000Z", { overwriteMunet: true });
    expect(repaired.state.scores["100:MAS"]).toMatchObject({ score, source: "lxns", updatedAt: "2026-10-04T00:00:00.000Z" });
    expect(repaired.state.scores["100:MAS"].rating).toBe(importSourcePayload(payload, "lxns", EMPTY_STATE, chartMap).state.scores["100:MAS"].rating);
    expect(repaired.state.scores["100:ULT"]).toEqual(before.scores["100:ULT"]);
    expect(repaired.state.nicknameOverrides).toEqual(before.nicknameOverrides);
    expect(repaired.report).toMatchObject({ updatedScores: 1, replacedMunetScores: 1, skippedScores: 0 });
    expect(current).toEqual(before);
  });

  it("keeps normal highest-score behavior unless national-server repair is explicitly enabled", () => {
    const current = importSourcePayload({ userMusicDetailList: [
      { musicId: 100, level: 3, scoreMax: 1_005_000 },
    ] }, "munet", EMPTY_STATE, chartMap).state;
    for (const options of [undefined, { overwriteMunet: false }]) {
      for (const score of [1_000_000, 1_005_000]) {
        const merged = importSourcePayload([{ id: 100, level_index: 3, score }], "lxns", current, chartMap, undefined, options);
        expect(merged.state).toEqual(current);
        expect(merged.report).toMatchObject({ updatedScores: 0, skippedScores: 1 });
        expect(merged.report.replacedMunetScores).toBeUndefined();
      }
    }
  });

  it.each(["manual", "rin", "otogame", "lxns"] as const)("repair keeps the highest-score rule for an existing %s record", (source) => {
    const current = importSourcePayload([{ id: 100, level_index: 3, score: 1_005_000 }], "rin", EMPTY_STATE, chartMap).state;
    current.scores["100:MAS"].source = source;
    for (const score of [1_000_000, 1_005_000]) {
      const merged = importSourcePayload([{ id: 100, level_index: 3, score }], "lxns", current, chartMap, undefined, { overwriteMunet: true });
      expect(merged.state).toEqual(current);
      expect(merged.report.replacedMunetScores).toBeUndefined();
    }
    const raised = importSourcePayload([{ id: 100, level_index: 3, score: 1_009_000 }], "lxns", current, chartMap, undefined, { overwriteMunet: true });
    expect(raised.state.scores["100:MAS"]).toMatchObject({ score: 1_009_000, source: "lxns" });
    expect(raised.report).toMatchObject({ updatedScores: 1 });
    expect(raised.report.replacedMunetScores).toBeUndefined();
  });

  it.each(["rin", "otogame", "munet"] as const)("ignores national-server repair for incoming %s data", (source) => {
    const current = importSourcePayload({ userMusicDetailList: [
      { musicId: 100, level: 3, scoreMax: 1_005_000 },
    ] }, "munet", EMPTY_STATE, chartMap).state;
    const payload = source === "munet"
      ? { userMusicDetailList: [{ musicId: 100, level: 3, scoreMax: 1_000_000 }] }
      : [{ id: 100, level_index: 3, score: 1_000_000 }];
    const merged = importSourcePayload(payload, source, current, chartMap, undefined, { overwriteMunet: true });
    expect(merged.state).toEqual(current);
    expect(merged.report.replacedMunetScores).toBeUndefined();
  });

  it.each(["json", "csv"] as const)("repairs from national-server %s files after selecting the highest input per chart", (format) => {
    const current = importSourcePayload({ userMusicDetailList: [
      { musicId: 100, level: 3, scoreMax: 1_009_000 },
    ] }, "munet", EMPTY_STATE, chartMap).state;
    const rows = [{ id: 100, level_index: 3, score: 1_005_000 }, { id: 100, level_index: 3, score: 1_000_000 }];
    const raw = format === "json" ? JSON.stringify(rows) : "id,level_index,score\n100,3,1005000\n100,3,1000000";
    const merged = importSourceFile(raw, "lxns", current, chartMap, `scores.${format}`, { overwriteMunet: true });
    expect(merged.state.scores["100:MAS"]).toMatchObject({ score: 1_005_000, source: "lxns" });
    expect(merged.report).toMatchObject({ parsedScores: 2, updatedScores: 1, replacedMunetScores: 1, skippedScores: 1 });
  });

  it("leaves MuNET data unchanged for failed, invalid, or unmatched national-server input", () => {
    const current = importSourcePayload({ userMusicDetailList: [
      { musicId: 100, level: 3, scoreMax: 1_009_000 },
    ] }, "munet", EMPTY_STATE, chartMap).state;
    const before = structuredClone(current);
    const options = { overwriteMunet: true };
    expect(() => importSourceJson("invalid JSON", "lxns", current, chartMap, options)).toThrow("JSON");
    expect(() => importSourceFile("id,score\n100,1000000", "lxns", current, chartMap, "scores.csv", options)).toThrow("表头");
    const merged = importSourcePayload([
      { id: 999, level_index: 3, score: 1_000_000 },
      { id: 100, level_index: 3, score: -1 },
    ], "lxns", current, chartMap, undefined, options);
    expect(merged.state).toEqual(before);
    expect(merged.report).toMatchObject({ unknownCharts: 1, invalidEntries: 1, updatedScores: 0 });
    expect(merged.report.replacedMunetScores).toBeUndefined();
    expect(current).toEqual(before);
  });

  it.each(["munet", "rin", "otogame", "lxns"] as const)("imports 13.0 and 13.9 from %s and keeps below-range charts outside the catalog", (source) => {
    const { state, report } = importSourcePayload(lowerScorePayload(source), source, structuredClone(EMPTY_STATE), expandedChartMap);
    expect(report).toMatchObject({ parsedScores: 3, importedScores: 2, unknownCharts: 1, invalidEntries: 0 });
    expect(state.scores["300:EXP"]).toMatchObject({ constant: 13.0, score: 1_005_000, rating: 14.5, source });
    expect(state.scores["301:MAS"]).toMatchObject({ constant: 13.9, score: 1_005_000, rating: 15.4, source });
    expect(Object.keys(state.scores)).toHaveLength(2);
    const restored = parseLocalState(JSON.stringify(state));
    expect(restored).toEqual(state);
    const exported = createB30Export(Object.values(restored.scores), expandedChartMap, "Mate-test-13plus");
    expect(exported.b30.slice(0, 2)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "300", constant: 13.0, source }),
      expect.objectContaining({ id: "301", constant: 13.9, source }),
    ]));
  });

  it.each(["munet", "rin", "otogame", "lxns"] as const)("preserves aliases and existing higher or equal scores when %s adds lower charts", (source) => {
    const current = importSourcePayload(lowerScorePayload("rin", 1_007_500), "rin", structuredClone(EMPTY_STATE), expandedChartMap).state;
    current.scores["300:EXP"].source = "manual";
    current.scores["301:MAS"].source = "lxns";
    current.nicknameOverrides["300"] = ["十三定数别名"];
    const before = structuredClone(current);
    for (const score of [1_005_000, 1_007_500]) {
      const kept = importSourcePayload(lowerScorePayload(source, score), source, current, expandedChartMap);
      expect(kept.state).toEqual(before);
      expect(kept.report).toMatchObject({ updatedScores: 0, skippedScores: 2 });
    }
    const updated = importSourcePayload(lowerScorePayload(source, 1_009_000), source, current, expandedChartMap);
    expect(updated.report.updatedScores).toBe(2);
    expect(updated.state.scores["300:EXP"]).toMatchObject({ score: 1_009_000, source });
    expect(updated.state.scores["301:MAS"]).toMatchObject({ score: 1_009_000, source });
    expect(updated.state.nicknameOverrides).toEqual(before.nicknameOverrides);
    expect(current).toEqual(before);
  });

  it("imports MuNET best scores and preserves the source through storage and B30 export", () => {
    const payload = {
      gameId: "SDHD",
      userData: { userName: "Private player", musicId: 200, level: 2, score: 1_010_000 },
      userMusicDetailList: [
        { musicId: 100, level: 3, scoreMax: 1_000_000, score: 1, rating: 99 },
        { musicId: "100", level: "4", scoreMax: "1009000" },
        { musicId: 200, level: 2, scoreMax: 1_005_000 },
      ],
      userPlaylogList: [{ musicId: 100, level: 3, score: 1_010_000 }],
    };
    const { state, report } = importSourceFile(
      `\uFEFF${JSON.stringify(payload)}`, "munet", structuredClone(EMPTY_STATE), chartMap, "munet.json",
    );
    expect(report).toMatchObject({ parsedScores: 3, importedScores: 3, invalidEntries: 0 });
    expect(state.scores["100:MAS"]).toMatchObject({ title: "Master Song", score: 1_000_000, rating: 15.3, source: "munet" });
    expect(state.scores["100:ULT"].score).toBe(1_009_000);
    expect(state.scores["200:EXP"].score).toBe(1_005_000);
    expect(JSON.stringify(state)).not.toContain("Private player");
    const restored = parseLocalState(JSON.stringify(state));
    expect(restored).toEqual(state);
    const exported = createB30Export(Object.values(restored.scores), chartMap, "test");
    expect(JSON.stringify(exported)).toContain('"source":"munet"');
  });

  it("merges MuNET duplicates and higher scores without changing the original state", () => {
    const current = importSourcePayload(
      [{ musicId: 100, level: 3, score: 1_005_000 }], "rin", structuredClone(EMPTY_STATE), chartMap,
    ).state;
    const before = structuredClone(current);
    const { state, report } = importSourcePayload({ userMusicDetailList: [
      { musicId: 100, level: 3, scoreMax: 1_000_000 },
      { musicId: 100, level: 3, scoreMax: 1_009_000 },
      { musicId: 999, level: 3, scoreMax: 1_000_000 },
      { musicId: 100, level: 0, scoreMax: 1_000_000 },
      { musicId: 100, level: 4, scoreMax: 1_010_001 },
      null,
    ] }, "munet", current, chartMap);
    expect(current).toEqual(before);
    expect(state.scores["100:MAS"]).toMatchObject({ score: 1_009_000, source: "munet" });
    expect(report).toMatchObject({ parsedScores: 6, updatedScores: 1, skippedScores: 1, unknownCharts: 1, invalidEntries: 3 });
    const repeated = importSourcePayload({ userMusicDetailList: [
      { musicId: 100, level: 3, scoreMax: 1_005_000 },
    ] }, "munet", state, chartMap);
    expect(repeated.state).toEqual(state);
    expect(repeated.report.skippedScores).toBe(1);
  });

  it("rejects other games and malformed MuNET exports while accepting an empty score list", () => {
    for (const payload of [null, [], {}, { userMusicDetailList: {} }, { gameId: "SDEZ", userMusicDetailList: [] }]) {
      expect(() => importSourcePayload(payload, "munet", structuredClone(EMPTY_STATE), chartMap)).toThrow("MuNET");
    }
    const result = importSourcePayload({ gameId: "SDHD", userMusicDetailList: [] }, "munet", structuredClone(EMPTY_STATE), chartMap);
    expect(result.state).toEqual(EMPTY_STATE);
    expect(result.report.parsedScores).toBe(0);
  });

  it("imports LXNS response and recomputes catalog fields", () => {
    const { state, report } = importSourcePayload(
      { success: true, data: [{ id: 100, level_index: 3, score: 1_000_000, title: "Tampered" }] },
      "lxns",
      structuredClone(EMPTY_STATE),
      chartMap,
      "2026-08-03T00:00:00.000Z",
    );
    expect(report.importedScores).toBe(1);
    expect(state.scores["100:MAS"]).toMatchObject({
      title: "Master Song",
      constant: 14.3,
      rating: 15.3,
      source: "lxns",
    });
  });

  it("supports Rin rating and export field names", () => {
    const payload = {
      old: [{ musicId: 100, level: 4, score: 1_009_000 }],
      userMusicDetailList: [{ musicId: 200, level: 2, scoreMax: 1_005_000 }],
    };
    const { state, report } = importSourcePayload(payload, "rin", structuredClone(EMPTY_STATE), chartMap);
    expect(report.importedScores).toBe(2);
    expect(state.scores["100:ULT"].source).toBe("rin");
    expect(state.scores["200:EXP"].score).toBe(1_005_000);
  });

  it("matches Otogame rating records by nested music name", () => {
    const payload = {
      code: 0,
      data: {
        base_rating_list: [{
          difficulty: 3,
          music: {
            music_id: "284f01931003ee05c60446ca8cd922ca",
            name: "Ｍａｓｔｅｒ　Ｓｏｎｇ",
            level_info: { difficulty: 3, level: 22 },
          },
          score: 1_006_782,
          rating: 1665,
        }],
      },
    };
    const { state, report } = importSourcePayload(
      payload,
      "otogame",
      structuredClone(EMPTY_STATE),
      chartMap,
    );
    expect(report.importedScores).toBe(1);
    expect(state.scores["100:MAS"]).toMatchObject({ score: 1_006_782, source: "otogame" });
  });

  it("imports LXNS CSV including quoted fields", () => {
    const csv = [
      "id,song_name,level,level_index,score,rating,upload_time,play_time",
      '200,"Ignored, exported title",14,2,1005000,15.5,2026-08-03 12:00:00,',
    ].join("\r\n");
    const { state, report } = importSourceFile(
      csv,
      "lxns",
      structuredClone(EMPTY_STATE),
      chartMap,
      "chunithm-scores.csv",
    );
    expect(report.importedScores).toBe(1);
    expect(state.scores["200:EXP"]).toMatchObject({ score: 1_005_000, source: "lxns" });
  });

  it("rejects CSV under the wrong source and invalid LXNS headers", () => {
    expect(() => importSourceFile(
      "id,level_index,score\n100,3,1000000",
      "rin",
      structuredClone(EMPTY_STATE),
      chartMap,
      "scores.csv",
    )).toThrow("落雪");
    expect(() => importSourceFile(
      "song,score\nTest,1000000",
      "lxns",
      structuredClone(EMPTY_STATE),
      chartMap,
      "scores.csv",
    )).toThrow("表头");
  });

  it("supports common Otogame fields, rejects invalid data and keeps existing high scores", () => {
    const current = structuredClone(EMPTY_STATE);
    current.scores["100:MAS"] = {
      id: "100",
      title: "Master Song",
      difficulty: "MAS",
      constant: 14.3,
      score: 1_007_500,
      rating: 16.3,
      updatedAt: "2026-08-03T00:00:00.000Z",
      source: "manual",
    };
    const raw = JSON.stringify({ data: { records: [
      { music_id: "100", difficulty: "master", score_max: "1000000" },
      { song_id: "999", difficulty: "expert", score: 1_000_000 },
      { song_id: "200", difficulty: "invalid", score: 1_000_000 },
    ] } });
    const { state, report } = importSourceJson(raw, "otogame", current, chartMap);
    expect(state.scores["100:MAS"].source).toBe("manual");
    expect(report.skippedScores).toBe(1);
    expect(report.unknownCharts).toBe(1);
    expect(report.invalidEntries).toBe(1);
  });

  it("sends LXNS token only in the request header", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ success: true, data: [] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    await expect(fetchLxnsScores(" token-value ", fetcher as typeof fetch)).resolves.toMatchObject({ success: true });
    expect(fetcher).toHaveBeenCalledWith(
      "https://maimai.lxns.net/api/v0/user/chunithm/player/scores",
      { headers: { Accept: "application/json", "X-User-Token": "token-value" } },
    );
  });

  it("rejects invalid JSON and API failures", async () => {
    expect(() => importSourceJson("nope", "rin", structuredClone(EMPTY_STATE), chartMap)).toThrow("JSON");
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ success: false, code: 401 }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    ));
    await expect(fetchLxnsScores("bad", fetcher as typeof fetch)).rejects.toThrow("401");
  });
});
