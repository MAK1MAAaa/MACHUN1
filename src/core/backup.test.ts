import { describe, expect, it } from "vitest";
import type { CatalogChart, LocalState } from "../types";
import { createFullBackup, importBackup } from "./backup";
import { EMPTY_STATE } from "./storage";

const chart: CatalogChart = {
  id: "100",
  title: "Authoritative Title",
  difficulty: "MAS",
  constant: 14,
  genre: "ORIGINAL",
  version: "AIR PLUS",
  nickname: [],
  coverUrl: "https://example.com/100.jpg",
  bpm: 180,
  notes: { total: 1000, tap: 500, hold: 100, slide: 150, air: 200, flick: 50 },
};
const chartMap = new Map([["100:MAS", chart]]);

describe("backup import", () => {
  it("recomputes untrusted title, constant and rating", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      catalogVersion: "old",
      exportedAt: "invalid",
      scores: [{
        id: "100",
        title: "Tampered",
        difficulty: "MAS",
        constant: 99,
        score: 1_000_000,
        rating: 999,
        updatedAt: "2026-08-03T00:00:00.000Z",
      }],
      nicknameOverrides: { "100": ["alias", "ALIAS", ""] },
    });
    const { state, report } = importBackup(raw, structuredClone(EMPTY_STATE), chartMap, "merge");
    expect(report.importedScores).toBe(1);
    expect(state.scores["100:MAS"]).toMatchObject({
      title: "Authoritative Title",
      constant: 14,
      rating: 15,
    });
    expect(state.nicknameOverrides["100"]).toEqual(["alias"]);
  });

  it("merges by high score and skips unknown charts", () => {
    const current: LocalState = {
      schemaVersion: 2,
      scores: {
        "100:MAS": {
          id: "100",
          title: chart.title,
          difficulty: "MAS",
          constant: 14,
          score: 1_005_000,
          rating: 15.5,
          updatedAt: "2026-08-03T00:00:00.000Z",
          source: "manual",
        },
      },
      nicknameOverrides: {},
    };
    const raw = JSON.stringify({
      schemaVersion: 1,
      scores: [
        { id: "100", difficulty: "MAS", score: 1_000_000 },
        { id: "999", difficulty: "MAS", score: 1_000_000 },
      ],
      nicknameOverrides: {},
    });
    const { state, report } = importBackup(raw, current, chartMap, "merge");
    expect(state.scores["100:MAS"].score).toBe(1_005_000);
    expect(report.skippedScores).toBe(2);
    expect(report.warnings).toHaveLength(1);
  });

  it("keeps the highest duplicate when replacing from a malformed backup", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      scores: [
        { id: "100", difficulty: "MAS", score: 1_005_000 },
        { id: "100", difficulty: "MAS", score: 1_000_000 },
      ],
      nicknameOverrides: {},
    });
    const { state } = importBackup(raw, structuredClone(EMPTY_STATE), chartMap, "replace");
    expect(state.scores["100:MAS"].score).toBe(1_005_000);
  });

  it("rejects malformed JSON", () => {
    expect(() => importBackup("nope", structuredClone(EMPTY_STATE), chartMap, "merge")).toThrow("JSON");
  });

  it("restores an old localStorage object map and exports a full backup with marks and aliases", () => {
    const raw = JSON.stringify({ schemaVersion: 2, scores: { "100:MAS": { id: "100", difficulty: "MAS", score: 1_005_000, source: "rin", combo: "aj", fullChain: "gold" } }, nicknameOverrides: { "100": ["old alias"] } });
    const { state } = importBackup(raw, structuredClone(EMPTY_STATE), chartMap, "merge");
    const backup = createFullBackup(state, "test");
    expect(backup.scores).toHaveLength(1);
    expect(backup.scores[0]).toMatchObject({ source: "rin", combo: "aj", fullChain: "gold" });
    expect(backup.nicknameOverrides).toEqual({ "100": ["old alias"] });
    expect(importBackup(JSON.stringify(backup), structuredClone(EMPTY_STATE), chartMap, "replace").state).toEqual(state);
  });
});
