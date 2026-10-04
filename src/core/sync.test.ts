import { describe, expect, it } from "vitest";
import { catalog } from "./catalog";
import { EMPTY_STATE, correctScore } from "./storage";
import { importSourcePayload } from "./sources";
import type { ExternalScoreSource } from "./sources";
import { catalogByKey } from "./catalog";
import { mergeSyncResult } from "./sync";
import type { SyncResult } from "../syncTypes";
import type { CatalogChart } from "../types";

const chart = catalog[0];
function result(score: number): SyncResult {
  const normalized = importSourcePayload([{ id: chart.id, difficulty: chart.difficulty, score }], "rin", EMPTY_STATE, catalogByKey);
  return {
    source: "rin", records: Object.values(normalized.state.scores), report: normalized.report,
    connection: { source: "rin", status: "ready", bound: true, identity: null, lastAttemptAt: null, lastSuccessAt: null, error: null },
  };
}

function lowerChartResult(source: ExternalScoreSource, lowerCharts: CatalogChart[], score: number): SyncResult {
  const candidates = lowerCharts.map((candidate) => ({ musicId: candidate.id, level: candidate.difficulty, scoreMax: score }));
  const payload = source === "munet" ? { gameId: "SDHD", userMusicDetailList: candidates } : candidates;
  const normalized = importSourcePayload(payload, source, EMPTY_STATE, catalogByKey);
  return {
    source, records: Object.values(normalized.state.scores), report: normalized.report,
    connection: { source, status: "ready", bound: true, identity: null, lastAttemptAt: null, lastSuccessAt: null, error: null },
  };
}

describe("sync response merge", () => {
  it.each([1_000_000, 1_005_000, 1_009_000])("repairs a matching MuNET record with a national-server response scored %i", (score) => {
    const key = `${chart.id}:${chart.difficulty}`;
    const current = mergeSyncResult(EMPTY_STATE, lowerChartResult("munet", [chart], 1_005_000)).state;
    current.nicknameOverrides[chart.id] = ["保留别名"];
    const before = structuredClone(current);
    const incoming = lowerChartResult("lxns", [chart], score);
    const repaired = mergeSyncResult(current, incoming, { overwriteMunet: true });
    expect(repaired.state.scores[key]).toMatchObject({ score, source: "lxns" });
    expect(repaired.state.nicknameOverrides).toEqual(current.nicknameOverrides);
    expect(repaired.report).toMatchObject({ updatedScores: 1, replacedMunetScores: 1 });
    expect(current).toEqual(before);
  });

  it("does not apply a pending repair to a later manual edit or another source's score", () => {
    const key = `${chart.id}:${chart.difficulty}`;
    const initial = mergeSyncResult(EMPTY_STATE, lowerChartResult("munet", [chart], 1_009_000)).state;
    const pendingResult = lowerChartResult("lxns", [chart], 1_000_000);
    const edited = correctScore(initial, key, "1005000");
    const laterSynced = mergeSyncResult(edited, lowerChartResult("rin", [chart], 1_007_500)).state;
    for (const latest of [edited, laterSynced]) {
      const kept = mergeSyncResult(latest, pendingResult, { overwriteMunet: true });
      expect(kept.state).toEqual(latest);
      expect(kept.report).toMatchObject({ updatedScores: 0, skippedScores: 1 });
      expect(kept.report.replacedMunetScores).toBeUndefined();
    }
  });

  it("preserves unmatched MuNET scores and aliases during repair", () => {
    const otherChart = catalog.find((candidate) => candidate.id !== chart.id)!;
    const otherKey = `${otherChart.id}:${otherChart.difficulty}`;
    const initial = mergeSyncResult(EMPTY_STATE, lowerChartResult("munet", [chart, otherChart], 1_009_000)).state;
    initial.nicknameOverrides[otherChart.id] = ["未匹配曲目别名"];
    const repaired = mergeSyncResult(initial, lowerChartResult("lxns", [chart], 1_000_000), { overwriteMunet: true });
    expect(repaired.state.scores[otherKey]).toEqual(initial.scores[otherKey]);
    expect(repaired.state.nicknameOverrides).toEqual(initial.nicknameOverrides);
    const empty = mergeSyncResult(initial, lowerChartResult("lxns", [], 1_000_000), { overwriteMunet: true });
    expect(empty.state).toEqual(initial);
    expect(empty.report.replacedMunetScores).toBeUndefined();
  });

  it.each(["munet", "rin", "otogame", "lxns"] as const)("merges real 13.0 and 13.9 %s charts while preserving edits and aliases at response time", (source) => {
    const lowerCharts = [13.0, 13.9].map((constant) => {
      const lowerChart = catalog.find((candidate) => candidate.constant === constant);
      expect(lowerChart, `catalog contains a ${constant.toFixed(1)} chart`).toBeDefined();
      return lowerChart!;
    });
    const incoming = lowerChartResult(source, lowerCharts, 1_005_000);
    expect(incoming.records).toHaveLength(2);
    const key = `${lowerCharts[0].id}:${lowerCharts[0].difficulty}`;
    const previousChart = catalog.find((candidate) => candidate.constant >= 14)!;
    const previousKey = `${previousChart.id}:${previousChart.difficulty}`;
    const unrelated = mergeSyncResult(EMPTY_STATE, lowerChartResult("rin", [previousChart], 1_007_500)).state;
    const initial = mergeSyncResult(unrelated, incoming).state;
    initial.nicknameOverrides[lowerCharts[0].id] = ["扩展曲库别名"];
    const raised = correctScore(initial, key, "1009000");
    const before = structuredClone(raised);
    const kept = mergeSyncResult(raised, incoming);
    expect(kept.state).toEqual(raised);
    expect(kept.state.scores[key]).toMatchObject({ constant: 13.0, score: 1_009_000, source: "manual" });
    expect(kept.report).toMatchObject({ importedScores: 0, updatedScores: 0, skippedScores: 2 });
    const lowered = correctScore(raised, key, "990000");
    const updated = mergeSyncResult(lowered, incoming);
    expect(updated.state.scores[key]).toMatchObject({ constant: 13.0, score: 1_005_000, source });
    expect(updated.report.updatedScores).toBe(1);
    expect(updated.state.nicknameOverrides).toEqual(before.nicknameOverrides);
    expect(updated.state.scores[previousKey]).toEqual(unrelated.scores[previousKey]);
    expect(raised).toEqual(before);
  });

  it("preserves edits made while a request was pending, but replaces a manual lower score", () => {
    const key = `${chart.id}:${chart.difficulty}`;
    const initial = mergeSyncResult(EMPTY_STATE, result(1_000_000)).state;
    const raised = correctScore(initial, key, "1009000");
    const kept = mergeSyncResult(raised, result(1_005_000));
    expect(kept.state.scores[key]).toMatchObject({ score: 1_009_000, source: "manual" });
    expect(kept.report.skippedScores).toBe(1);
    const lowered = correctScore(raised, key, "990000");
    const updated = mergeSyncResult(lowered, result(1_005_000));
    expect(updated.state.scores[key]).toMatchObject({ score: 1_005_000, source: "rin" });
    expect(updated.report.updatedScores).toBe(1);
    expect(lowered.scores[key].score).toBe(990_000);
  });

  it("keeps an equal-score source, aliases, and unrelated records", () => {
    const key = `${chart.id}:${chart.difficulty}`;
    const state = correctScore(mergeSyncResult(EMPTY_STATE, result(1_005_000)).state, key, "1005000");
    state.nicknameOverrides[chart.id] = ["我的别名"];
    const merged = mergeSyncResult(state, result(1_005_000));
    expect(merged.state).toEqual(state);
    expect(merged.state.scores[key].source).toBe("manual");
  });

  it("recomputes catalog fields instead of trusting incoming rating or title", () => {
    const incoming = result(1_005_000);
    incoming.records[0].rating = 999;
    incoming.records[0].title = "untrusted";
    const merged = mergeSyncResult(EMPTY_STATE, incoming);
    expect(Object.values(merged.state.scores)[0]).toMatchObject({ title: chart.title, constant: chart.constant });
    expect(Object.values(merged.state.scores)[0].rating).not.toBe(999);
  });
});
