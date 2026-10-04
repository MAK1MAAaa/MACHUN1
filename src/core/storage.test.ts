import { describe, expect, it } from "vitest";
import type { LocalState, SingleRating } from "../types";
import { EMPTY_STATE, parseLocalState, upsertHighScore, correctScore, enterManualScore } from "./storage";
import { catalog } from "./catalog";
import { chartKey } from "./b30";
import { calculateRating } from "./rating";

function rating(score: number): SingleRating {
  return {
    id: "100",
    title: "Test Song",
    difficulty: "MAS",
    constant: 14,
    score,
    rating: 15,
    updatedAt: "2026-08-03T00:00:00.000Z",
    source: "manual",
  };
}

describe("local storage model", () => {
  it("keeps only a higher score during normal entry", () => {
    const state: LocalState = structuredClone(EMPTY_STATE);
    expect(upsertHighScore(state, rating(1_000_000))).toBe("created");
    expect(upsertHighScore(state, rating(999_999))).toBe("rejected");
    expect(upsertHighScore(state, rating(1_000_001))).toBe("updated");
    expect(state.scores["100:MAS"].score).toBe(1_000_001);
  });

  it("rejects corrupted or unsupported persisted state", () => {
    expect(() => parseLocalState("not-json")).toThrow();
    expect(() => parseLocalState(JSON.stringify({ ...EMPTY_STATE, schemaVersion: 3 }))).toThrow("版本");
    expect(() => parseLocalState(JSON.stringify({ ...EMPTY_STATE, scores: { a: { invalid: true } } }))).toThrow("成绩");
  });

  it("migrates version 1 scores to manual source", () => {
    const legacy = {
      schemaVersion: 1,
      scores: { "100:MAS": { ...rating(1_000_000), source: undefined } },
      nicknameOverrides: {},
    };
    const state = parseLocalState(JSON.stringify(legacy));
    expect(state.schemaVersion).toBe(2);
    expect(state.scores["100:MAS"].source).toBe("manual");
  });
});


describe("manual score correction", () => {
  it("creates a score for an unplayed catalog chart and attributes it to manual entry", () => {
    const chart = catalog[0];
    const state = structuredClone(EMPTY_STATE);
    const next = enterManualScore(state, chart, "1000000");
    expect(next.scores[chartKey(chart)]).toMatchObject({
      id: chart.id, difficulty: chart.difficulty, score: 1_000_000,
      rating: calculateRating(1_000_000, chart.constant), source: "manual",
    });
    expect(state.scores).toEqual({});
    expect(parseLocalState(JSON.stringify(next))).toEqual(next);
    expect(() => enterManualScore(state, chart, "-1")).toThrow("整数");
  });
  it("overwrites a higher score, recomputes Rating and persists manual attribution", () => {
    const state = { ...structuredClone(EMPTY_STATE), scores: { "100:MAS": { ...rating(1_009_000), source: "rin" as const } } };
    const next = correctScore(state, "100:MAS", "1000000");
    expect(next.scores["100:MAS"]).toMatchObject({ score: 1_000_000, rating: 15, source: "manual" });
    expect(state.scores["100:MAS"].score).toBe(1_009_000);
    expect(parseLocalState(JSON.stringify(next))).toEqual(next);
  });
  it.each(["", "-1", "1.5", "1e6", "1000000abc", "1010001"])("rejects invalid input %s", (input) => {
    const state = { ...structuredClone(EMPTY_STATE), scores: { "100:MAS": rating(1_000_000) } };
    expect(() => correctScore(state, "100:MAS", input)).toThrow("整数");
  });
  it("accepts score limits and rejects deleted records", () => {
    const state = { ...structuredClone(EMPTY_STATE), scores: { "100:MAS": rating(1_000_000) } };
    expect(correctScore(state, "100:MAS", "0").scores["100:MAS"].rating).toBe(0);
    expect(correctScore(state, "100:MAS", "1010000").scores["100:MAS"].rating).toBe(16.15);
    expect(() => correctScore(EMPTY_STATE, "100:MAS", "1000000")).toThrow("不存在");
  });
});
