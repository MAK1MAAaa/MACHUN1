import type {
  CatalogChart,
  ImportMode,
  ImportReport,
  LocalState,
  ScoreSource,
  SingleRating,
} from "../types";
import { calculateRating } from "./rating";
import { readScoreAchievements } from "./scoreAchievements";
import { upsertHighScore } from "./storage";

function normalizeAliases(aliases: unknown): string[] {
  if (!Array.isArray(aliases)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of aliases) {
    if (typeof value !== "string") continue;
    const alias = value.normalize("NFKC").trim();
    const key = alias.toLocaleLowerCase("zh-CN");
    if (!alias || seen.has(key)) continue;
    seen.add(key);
    normalized.push(alias);
  }
  return normalized;
}

export function importBackup(
  raw: string,
  current: LocalState,
  charts: Map<string, CatalogChart>,
  mode: ImportMode,
): { state: LocalState; report: ImportReport } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("备份文件不是有效的 JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("备份文件格式无效");
  const backup = parsed as Record<string, unknown>;
  if (backup.schemaVersion !== 1 && backup.schemaVersion !== 2) {
    throw new Error("备份版本不受支持");
  }
  if (!Array.isArray(backup.scores)) throw new Error("备份缺少成绩列表");

  const state: LocalState = mode === "replace" ? structuredClone({
    schemaVersion: 2,
    scores: {},
    nicknameOverrides: {},
  }) : structuredClone(current);
  const report: ImportReport = {
    importedScores: 0,
    skippedScores: 0,
    importedAliases: 0,
    warnings: [],
  };

  for (const value of backup.scores) {
    if (!value || typeof value !== "object") {
      report.skippedScores += 1;
      continue;
    }
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.id !== "string" ||
      (candidate.difficulty !== "EXP" && candidate.difficulty !== "MAS" && candidate.difficulty !== "ULT") ||
      typeof candidate.score !== "number" ||
      !Number.isInteger(candidate.score) ||
      candidate.score < 0 ||
      candidate.score > 1_010_000
    ) {
      report.skippedScores += 1;
      continue;
    }

    const key = `${candidate.id}:${candidate.difficulty}`;
    const chart = charts.get(key);
    if (!chart) {
      report.skippedScores += 1;
      report.warnings.push(`已跳过曲库中不存在的谱面：${key}`);
      continue;
    }

    const score = candidate.score as number;
    const record: SingleRating = {
      id: chart.id,
      title: chart.title,
      difficulty: chart.difficulty,
      constant: chart.constant,
      score,
      rating: calculateRating(score, chart.constant),
      updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date().toISOString(),
      source: parseSource(candidate.source),
      ...readScoreAchievements(candidate),
    };
    if (upsertHighScore(state, record) !== "rejected") {
      report.importedScores += 1;
    } else {
      report.skippedScores += 1;
    }
  }

  if (backup.nicknameOverrides && typeof backup.nicknameOverrides === "object") {
    for (const [id, aliases] of Object.entries(backup.nicknameOverrides)) {
      const imported = normalizeAliases(aliases);
      if (imported.length === 0) continue;
      const existing = mode === "replace" ? [] : state.nicknameOverrides[id] ?? [];
      const merged = normalizeAliases([...existing, ...imported]);
      state.nicknameOverrides[id] = merged;
      report.importedAliases += merged.length - existing.length;
    }
  }

  return { state, report };
}

function parseSource(value: unknown): ScoreSource {
  if (value === "rin" || value === "otogame" || value === "lxns" || value === "munet") return value;
  return "manual";
}
