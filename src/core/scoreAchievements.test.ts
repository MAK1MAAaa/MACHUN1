import { describe, expect, it } from "vitest";
import { catalog, catalogByKey } from "./catalog";
import { chartKey } from "./b30";
import { scoreGrade } from "./rating";
import { mergeScoreAchievements, readScoreAchievements } from "./scoreAchievements";
import { importSourcePayload } from "./sources";
import { correctScore, EMPTY_STATE, parseLocalState, upsertHighScore } from "./storage";
import { createB30Export, createB30CandidatesExport, createOtoB30Export } from "./b30Export";
import { mergeSyncResult } from "./sync";
import { safeMusicDetails } from "../../server/providers/browserHttp";
import type { LocalState, SingleRating } from "../types";
import type { SyncResult } from "../syncTypes";

const chart = catalog[0];
const level = { EXP: 2, MAS: 3, ULT: 4 }[chart.difficulty];
const key = chartKey(chart);
const makeRecord = (score: number): SingleRating => ({
  id: chart.id, title: chart.title, difficulty: chart.difficulty, constant: chart.constant,
  score, rating: 15, updatedAt: "2026-10-08T00:00:00.000Z", source: "rin",
});

describe("score achievements", () => {
  it.each([
    [{ isFullCombo: true }, { combo: "fc" }],
    [{ is_full_combo: "TRUE" }, { combo: "fc" }],
    [{ isFullCombo: true, isAllJustice: true }, { combo: "aj" }],
    [{ full_combo: "alljusticecritical" }, { combo: "ajc" }],
    [{ fc: "FULL COMBO" }, { combo: "fc" }],
    [{ full_chain: "fullchain2" }, { fullChain: "gold" }],
    [{ full_chain: "fullchain" }, { fullChain: "platinum" }],
    [{ isFullChain: true }, { fullChain: "fchain" }],
    [{ isFullCombo: false, full_combo: "invalid", fullChain: 99 }, {}],
  ])("normalizes supported source metadata %j", (input, expected) => {
    expect(readScoreAchievements(input)).toEqual(expected);
  });

  it("recognizes AJC only at the exact perfect score without inferring FC/AJ from other scores", () => {
    expect(readScoreAchievements({}, 1_010_000)).toEqual({ combo: "ajc" });
    expect(readScoreAchievements({}, 1_009_999)).toEqual({});
    expect(readScoreAchievements({ isAllJustice: true }, 1_009_999)).toEqual({ combo: "aj" });
  });

  it("keeps the highest combo and chain independently", () => {
    expect(mergeScoreAchievements({ combo: "aj", fullChain: "gold" }, { combo: "fc", fullChain: "platinum" }))
      .toEqual({ combo: "aj", fullChain: "platinum" });
    expect(mergeScoreAchievements({ combo: "ajc", fullChain: "platinum" }, {}))
      .toEqual({ combo: "ajc", fullChain: "platinum" });
  });

  it.each(["rin", "munet", "otogame", "lxns"] as const)("retains metadata while importing %s", (source) => {
    const native = { musicId: chart.id, level, scoreMax: 1_009_000, isAllJustice: true };
    const payload = source === "munet" ? { gameId: "SDHD", userMusicDetailList: [native] }
      : source === "rin" ? { userMusicDetailList: [native] }
      : source === "lxns" ? [{ id: chart.id, level_index: level, score: 1_009_000, full_combo: "alljustice" }]
      : [{ music: { name: chart.title }, difficulty: level, score: 1_009_000, isAllJustice: true }];
    expect(importSourcePayload(payload, source, EMPTY_STATE, catalogByKey).state.scores[key])
      .toMatchObject({ source, score: 1_009_000, combo: "aj" });
  });

  it("whitelists portal export metadata while excluding account and other raw fields", () => {
    const result = safeMusicDetails({
      userData: { token: "synthetic-private-token" },
      userMusicDetailList: [{ musicId: chart.id, level, scoreMax: 1_009_000, isFullCombo: true, privateField: "private" }],
    }, false);
    expect(result).toEqual({ userMusicDetailList: [{ musicId: chart.id, level, scoreMax: 1_009_000, combo: "fc" }] });
  });

  it("merges lower-score achievements without replacing the best score or source", () => {
    const state: LocalState = structuredClone(EMPTY_STATE);
    upsertHighScore(state, { ...makeRecord(1_009_000), combo: "fc" });
    expect(upsertHighScore(state, { ...makeRecord(1_008_000), source: "otogame", combo: "aj" })).toBe("updated");
    expect(state.scores[key]).toMatchObject({ score: 1_009_000, source: "rin", combo: "aj" });
    upsertHighScore(state, makeRecord(1_009_500));
    expect(state.scores[key]).toMatchObject({ score: 1_009_500, combo: "aj" });
    expect(parseLocalState(JSON.stringify(state))).toEqual(state);
    expect(correctScore(state, key, "990000").scores[key]).toMatchObject({ score: 990_000, source: "manual", combo: "aj" });
  });

  it("preserves national-server guards and resets foreign metadata during explicit repair", () => {
    const current: LocalState = { ...structuredClone(EMPTY_STATE), scores: { [key]: { ...makeRecord(1_009_000), source: "lxns", combo: "fc" } } };
    const munet = { userMusicDetailList: [{ musicId: chart.id, level, scoreMax: 1_008_000, isAllJustice: true }] };
    expect(importSourcePayload(munet, "munet", current, catalogByKey).state).toEqual(current);
    current.scores[key] = { ...current.scores[key], source: "munet", combo: "ajc" };
    const repaired = importSourcePayload([{ id: chart.id, level_index: level, score: 1_000_000, full_combo: "fullcombo" }],
      "lxns", current, catalogByKey, undefined, { overwriteMunet: true });
    expect(repaired.state.scores[key]).toMatchObject({ score: 1_000_000, source: "lxns", combo: "fc" });
  });

  it("retains achievements in both image datasets and through OTO JSON round trips", () => {
    const record = { ...makeRecord(1_009_000), combo: "aj" as const, fullChain: "gold" as const };
    expect(createB30Export([record], catalogByKey, "test").b30[0]).toMatchObject({ combo: "aj", fullChain: "gold", score: record.score });
    expect(createB30CandidatesExport([record], catalogByKey, "test").b30[0]).toMatchObject({ combo: "aj", fullChain: "gold", score: record.score });
    const json = createOtoB30Export([record]);
    expect(json.data.base_rating_list[0]).toMatchObject({ full_combo: "alljustice", full_chain: "fullchain2" });
    expect(importSourcePayload(json, "otogame", EMPTY_STATE, catalogByKey).state.scores[key])
      .toMatchObject({ combo: "aj", fullChain: "gold" });
  });

  it("merges a delayed sync into the latest edited state while retaining lamps", () => {
    const record = { ...makeRecord(1_009_000), combo: "aj" as const };
    const current = { ...structuredClone(EMPTY_STATE), scores: { [key]: { ...makeRecord(1_009_500), source: "manual" as const } } };
    const result: SyncResult = {
      source: "rin", records: [record],
      report: { parsedScores: 1, importedScores: 1, updatedScores: 0, skippedScores: 0, unknownCharts: 0, invalidEntries: 0 },
      connection: { source: "rin", status: "ready", bound: true, identity: null, lastAttemptAt: null, lastSuccessAt: null, error: null },
    };
    expect(mergeSyncResult(current, result).state.scores[key]).toMatchObject({ score: 1_009_500, source: "manual", combo: "aj" });
    expect(current.scores[key]).not.toHaveProperty("combo");
  });

  it.each([[1_009_000, "SSS+"], [1_008_999, "SSS"], [1_007_500, "SSS"], [1_007_499, "SS+"],
    [1_005_000, "SS+"], [1_000_000, "SS"], [700_000, "BB"], [600_000, "B"]])("grades score %i as %s", (score, grade) => {
    expect(scoreGrade(Number(score))).toBe(grade);
  });
});
