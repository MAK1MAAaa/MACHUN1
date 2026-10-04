import { SCORE_SOURCES, type CatalogChart, type LocalState, type ScoreSource, type SingleRating } from "../types";
import { chartKey } from "./b30";
import { calculateRating } from "./rating";

export const STORAGE_KEY = "chunithm-mate-b30:v2";
export const LEGACY_STORAGE_KEY = "chunithm-mate-b30:v1";

export const EMPTY_STATE: LocalState = {
  schemaVersion: 2,
  scores: {},
  nicknameOverrides: {},
};

function isScoreSource(value: unknown): value is ScoreSource {
  return typeof value === "string" && SCORE_SOURCES.includes(value as ScoreSource);
}

function normalizeRatingRecord(value: unknown, isLegacy: boolean): SingleRating | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const valid = (
    typeof record.id === "string" &&
    typeof record.title === "string" &&
    (record.difficulty === "EXP" || record.difficulty === "MAS" || record.difficulty === "ULT") &&
    typeof record.constant === "number" &&
    Number.isFinite(record.constant) &&
    typeof record.score === "number" &&
    Number.isInteger(record.score) &&
    record.score >= 0 &&
    record.score <= 1_010_000 &&
    typeof record.rating === "number" &&
    Number.isFinite(record.rating) &&
    typeof record.updatedAt === "string" &&
    (isLegacy || isScoreSource(record.source))
  );
  if (!valid) return null;
  return {
    ...(record as unknown as Omit<SingleRating, "source">),
    source: isScoreSource(record.source) ? record.source : "manual",
  };
}

export function parseLocalState(raw: string | null): LocalState {
  if (!raw) return structuredClone(EMPTY_STATE);

  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("本地数据不是对象");
  const state = value as Record<string, unknown>;
  if (state.schemaVersion !== 1 && state.schemaVersion !== 2) {
    throw new Error("本地数据版本不受支持");
  }
  const isLegacy = state.schemaVersion === 1;
  if (!state.scores || typeof state.scores !== "object") throw new Error("成绩数据无效");
  if (!state.nicknameOverrides || typeof state.nicknameOverrides !== "object") {
    throw new Error("别名数据无效");
  }

  const scores: Record<string, SingleRating> = {};
  for (const value of Object.values(state.scores)) {
    const record = normalizeRatingRecord(value, isLegacy);
    if (!record) throw new Error("存在无效成绩记录");
    scores[chartKey(record)] = record;
  }

  const nicknameOverrides: Record<string, string[]> = {};
  for (const [id, aliases] of Object.entries(state.nicknameOverrides)) {
    if (!Array.isArray(aliases) || aliases.some((alias) => typeof alias !== "string")) {
      throw new Error(`歌曲 ${id} 的别名无效`);
    }
    nicknameOverrides[id] = aliases;
  }

  return { schemaVersion: 2, scores, nicknameOverrides };
}

export function loadLocalState(storage: Pick<Storage, "getItem">): LocalState {
  const current = storage.getItem(STORAGE_KEY);
  if (current) return parseLocalState(current);
  return parseLocalState(storage.getItem(LEGACY_STORAGE_KEY));
}

export function saveLocalState(storage: Pick<Storage, "setItem">, state: LocalState): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function clearLocalState(storage: Pick<Storage, "removeItem">): void {
  storage.removeItem(STORAGE_KEY);
  storage.removeItem(LEGACY_STORAGE_KEY);
}

export type UpsertResult = "created" | "updated" | "rejected";

function parseManualScore(input: string): number {
  const value = input.trim();
  if (!/^\d+$/.test(value) || Number(value) > 1_010_000) {
    throw new Error("分数必须是 0 到 1,010,000 的整数");
  }
  return Number(value);
}

/** Explicit manual entry can create an unplayed chart or lower its current score. */
export function enterManualScore(state: LocalState, chart: CatalogChart, input: string): LocalState {
  const score = parseManualScore(input);
  return {
    ...state,
    scores: {
      ...state.scores,
      [chartKey(chart)]: {
        id: chart.id, title: chart.title, difficulty: chart.difficulty, constant: chart.constant,
        score, rating: calculateRating(score, chart.constant), source: "manual", updatedAt: new Date().toISOString(),
      },
    },
  };
}

export function correctScore(state: LocalState, key: string, input: string): LocalState {
  const score = parseManualScore(input);
  const record = state.scores[key];
  if (!record) throw new Error("该成绩已不存在，请重新选择");
  return {
    ...state,
    scores: {
      ...state.scores,
      [key]: {
        ...record,
        score,
        rating: calculateRating(score, record.constant),
        source: "manual",
        updatedAt: new Date().toISOString(),
      },
    },
  };
}

export function upsertHighScore(state: LocalState, record: SingleRating): UpsertResult {
  const key = chartKey(record);
  const existing = state.scores[key];
  if (existing && existing.score >= record.score) return "rejected";
  state.scores[key] = record;
  return existing ? "updated" : "created";
}
