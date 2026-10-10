import type { LocalState } from "../types";
import type { SyncResult } from "../syncTypes";
import { catalogByKey } from "./catalog";
import { importSourcePayload, type SourceMergeOptions } from "./sources";
import { mergeScoreAchievements } from "./scoreAchievements";

/** Merge against the state at response time; never replace it with a request-time snapshot. */
export function mergeSyncResult(current: LocalState, result: SyncResult, options: SourceMergeOptions = {}) {
  const candidates = result.records.map((record) => ({
    musicId: record.id,
    level: record.difficulty,
    scoreMax: record.score,
    updatedAt: record.updatedAt,
    ...mergeScoreAchievements(record, {}),
  }));
  const payload = result.source === "munet"
    ? { gameId: "SDHD", userMusicDetailList: candidates }
    : candidates;
  const merged = importSourcePayload(payload, result.source, current, catalogByKey, undefined, options);
  return {
    state: merged.state,
    report: {
      ...result.report,
      importedScores: merged.report.importedScores,
      updatedScores: merged.report.updatedScores,
      skippedScores: result.report.skippedScores + merged.report.skippedScores,
      unknownCharts: result.report.unknownCharts + merged.report.unknownCharts,
      invalidEntries: result.report.invalidEntries + merged.report.invalidEntries,
      ...(merged.report.replacedMunetScores === undefined ? {} : { replacedMunetScores: merged.report.replacedMunetScores }),
    },
  };
}
