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

export function createFullBackup(state: LocalState, catalogVersion: string) {
  return { schemaVersion: 2, catalogVersion, exportedAt: new Date().toISOString(),
    scores: Object.values(state.scores), nicknameOverrides: structuredClone(state.nicknameOverrides) };
}

export function downloadFullBackup(backup: ReturnType<typeof createFullBackup>): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url; link.download = "machun1-backup.json"; link.click();
  URL.revokeObjectURL(url);
}

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
  const scoreList = Array.isArray(backup.scores) ? backup.scores
    : backup.scores && typeof backup.scores === "object" ? Object.values(backup.scores) : null;
  if (!scoreList) throw new Error("备份缺少成绩列表");

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

  for (const value of scoreList) {
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
      if (["__proto__", "constructor", "prototype"].includes(id)) continue;
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
