import type {
  CatalogChart,
  Difficulty,
  LocalState,
  ScoreSource,
  SingleRating,
} from "../types";
import { calculateRating } from "./rating";
import { upsertHighScore } from "./storage";

export type ExternalScoreSource = Exclude<ScoreSource, "manual">;

export interface SourceMergeOptions {
  overwriteMunet?: boolean;
}

export const SCORE_SOURCE_LABELS: Record<ScoreSource, string> = {
  manual: "神秘游客",
  rin: "Rin服",
  otogame: "大饼",
  lxns: "国服",
  munet: "MuNET",
};

export interface SourceImportReport {
  parsedScores: number;
  importedScores: number;
  updatedScores: number;
  skippedScores: number;
  unknownCharts: number;
  invalidEntries: number;
  replacedMunetScores?: number;
}

const SCORE_FIELDS = ["score", "score_max", "scoreMax"] as const;
const ID_FIELDS = ["song_id", "songId", "music_id", "musicId", "id"] as const;
const DIFFICULTY_FIELDS = ["difficulty", "level_index", "levelIndex", "level", "diff"] as const;
const TITLE_FIELDS = ["song_name", "songName", "music_name", "musicName", "title", "name"] as const;
const DATE_FIELDS = [
  "play_time",
  "playTime",
  "userPlayDate",
  "last_played_time",
  "upload_time",
  "updatedAt",
] as const;

function readField(record: Record<string, unknown>, fields: readonly string[]): unknown {
  for (const field of fields) {
    if (record[field] !== undefined && record[field] !== null) return record[field];
  }
  return undefined;
}

function readSongId(record: Record<string, unknown>): string | null {
  const nestedSong = record.song;
  if (nestedSong && typeof nestedSong === "object") {
    const nested = readField(nestedSong as Record<string, unknown>, ID_FIELDS);
    if (typeof nested === "string" || typeof nested === "number") return String(nested);
  }
  const value = readField(record, ID_FIELDS);
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function readSongTitle(record: Record<string, unknown>): string | null {
  for (const nestedField of ["music", "song"] as const) {
    const nestedValue = record[nestedField];
    if (!nestedValue || typeof nestedValue !== "object") continue;
    const nestedTitle = readField(nestedValue as Record<string, unknown>, TITLE_FIELDS);
    if (typeof nestedTitle === "string" && nestedTitle.trim()) return nestedTitle;
  }
  const value = readField(record, TITLE_FIELDS);
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeTitle(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("ja-JP");
}

function createTitleIndex(charts: Map<string, CatalogChart>): Map<string, CatalogChart | null> {
  const index = new Map<string, CatalogChart | null>();
  for (const chart of charts.values()) {
    const key = `${normalizeTitle(chart.title)}:${chart.difficulty}`;
    const existing = index.get(key);
    if (existing && existing.id !== chart.id) index.set(key, null);
    else if (existing === undefined) index.set(key, chart);
  }
  return index;
}

function parseDifficulty(value: unknown): Difficulty | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value === 2 ? "EXP" : value === 3 ? "MAS" : value === 4 ? "ULT" : null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim().toUpperCase();
  if (normalized === "2" || normalized === "EXP" || normalized === "EXPERT") return "EXP";
  if (normalized === "3" || normalized === "MAS" || normalized === "MASTER") return "MAS";
  if (normalized === "4" || normalized === "ULT" || normalized === "ULTIMA") return "ULT";
  return null;
}

function parseScore(value: unknown): number | null {
  const score = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value)
      : Number.NaN;
  return Number.isInteger(score) && score >= 0 && score <= 1_010_000 ? score : null;
}

function parseUpdatedAt(record: Record<string, unknown>, fallback: string): string {
  for (const field of DATE_FIELDS) {
    const value = record[field];
    if (typeof value === "string" && value.trim() && !Number.isNaN(Date.parse(value))) {
      return new Date(value).toISOString();
    }
  }
  return fallback;
}

function collectScoreCandidates(value: unknown, output: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectScoreCandidates(item, output);
    return;
  }
  if (!value || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  if (SCORE_FIELDS.some((field) => record[field] !== undefined)) {
    output.push(record);
    return;
  }
  for (const child of Object.values(record)) collectScoreCandidates(child, output);
}

export function importSourcePayload(
  payload: unknown,
  source: ExternalScoreSource,
  current: LocalState,
  charts: Map<string, CatalogChart>,
  now = new Date().toISOString(),
  options: SourceMergeOptions = {},
): { state: LocalState; report: SourceImportReport } {
  const candidates: Record<string, unknown>[] = [];
  if (source === "munet") {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("请选择 MuNET 导出的 CHUNITHM JSON 存档");
    }
    const data = payload as Record<string, unknown>;
    if (data.gameId !== undefined && data.gameId !== "SDHD") {
      throw new Error("该 MuNET 存档不是 CHUNITHM（SDHD）数据");
    }
    if (!Array.isArray(data.userMusicDetailList)) {
      throw new Error("MuNET 存档缺少 userMusicDetailList 成绩列表，请导出完整 CHUNITHM 存档");
    }
    for (const entry of data.userMusicDetailList) {
      const detail = entry && typeof entry === "object" && !Array.isArray(entry)
        ? entry as Record<string, unknown>
        : {};
      candidates.push({ musicId: detail.musicId, level: detail.level, scoreMax: detail.scoreMax });
    }
  } else {
    collectScoreCandidates(payload, candidates);
  }
  const report: SourceImportReport = {
    parsedScores: candidates.length,
    importedScores: 0,
    updatedScores: 0,
    skippedScores: 0,
    unknownCharts: 0,
    invalidEntries: 0,
  };
  const recordsByChart = new Map<string, SingleRating>();
  const titleIndex = createTitleIndex(charts);

  for (const candidate of candidates) {
    const id = readSongId(candidate);
    const title = readSongTitle(candidate);
    const difficulty = parseDifficulty(readField(candidate, DIFFICULTY_FIELDS));
    const score = parseScore(readField(candidate, SCORE_FIELDS));
    if ((!id && !title) || !difficulty || score === null) {
      report.invalidEntries += 1;
      continue;
    }

    const chart = (id ? charts.get(`${id}:${difficulty}`) : undefined)
      ?? (title ? titleIndex.get(`${normalizeTitle(title)}:${difficulty}`) : undefined);
    if (!chart) {
      report.unknownCharts += 1;
      continue;
    }
    const key = `${chart.id}:${chart.difficulty}`;

    const record: SingleRating = {
      id: chart.id,
      title: chart.title,
      difficulty: chart.difficulty,
      constant: chart.constant,
      score,
      rating: calculateRating(score, chart.constant),
      updatedAt: parseUpdatedAt(candidate, now),
      source,
    };
    const previous = recordsByChart.get(key);
    if (!previous || record.score > previous.score) recordsByChart.set(key, record);
  }

  const state = structuredClone(current);
  for (const record of recordsByChart.values()) {
    const key = `${record.id}:${record.difficulty}`;
    const existing = state.scores[key];
    if (source === "munet" && existing?.source === "lxns" && record.score <= existing.score) {
      // MuNET must strictly improve a national-server score to replace its value and source.
      report.skippedScores += 1;
      continue;
    }
    if (source === "lxns" && options.overwriteMunet && state.scores[key]?.source === "munet") {
      // Repair only matching records: a MuNET archive can contain scores imported from the national server.
      state.scores[key] = record;
      report.updatedScores += 1;
      report.replacedMunetScores = (report.replacedMunetScores ?? 0) + 1;
      continue;
    }
    const result = upsertHighScore(state, record);
    if (result === "created") report.importedScores += 1;
    else if (result === "updated") report.updatedScores += 1;
    else report.skippedScores += 1;
  }
  report.skippedScores += candidates.length - recordsByChart.size - report.unknownCharts - report.invalidEntries;
  return { state, report };
}

export function importSourceJson(
  raw: string,
  source: ExternalScoreSource,
  current: LocalState,
  charts: Map<string, CatalogChart>,
  options: SourceMergeOptions = {},
): { state: LocalState; report: SourceImportReport } {
  let payload: unknown;
  try {
    payload = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("导入文件不是有效的 JSON");
  }
  return importSourcePayload(payload, source, current, charts, undefined, options);
}

function parseCsv(raw: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (quoted) {
      if (character === '"' && raw[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && raw[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("CSV 中存在未闭合的引号");
  row.push(field);
  if (row.some((value) => value.length > 0)) rows.push(row);
  if (rows.length === 0) throw new Error("CSV 文件为空");

  const headers = rows[0].map((header, index) =>
    (index === 0 ? header.replace(/^\uFEFF/, "") : header).normalize("NFKC").trim(),
  );
  const requiredHeaders = ["id", "level_index", "score"];
  if (requiredHeaders.some((header) => !headers.includes(header))) {
    throw new Error("落雪 CSV 缺少 id、level_index 或 score 表头");
  }

  return rows.slice(1).map((values) => Object.fromEntries(
    headers.map((header, index) => [header, values[index] ?? ""]),
  ));
}

export function importSourceFile(
  raw: string,
  source: ExternalScoreSource,
  current: LocalState,
  charts: Map<string, CatalogChart>,
  filename: string,
  options: SourceMergeOptions = {},
): { state: LocalState; report: SourceImportReport } {
  const isCsv = filename.toLocaleLowerCase("en-US").endsWith(".csv");
  if (isCsv) {
    if (source !== "lxns") throw new Error("CSV 文件只支持从国服 · 落雪入口导入");
    return importSourcePayload(parseCsv(raw), source, current, charts, undefined, options);
  }
  return importSourceJson(raw, source, current, charts, options);
}

const LXNS_SCORES_URL = "https://maimai.lxns.net/api/v0/user/chunithm/player/scores";

export async function fetchLxnsScores(
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  const normalizedToken = token.trim();
  if (!normalizedToken) throw new Error("请输入落雪个人 API Token");
  const response = await fetcher(LXNS_SCORES_URL, {
    headers: {
      Accept: "application/json",
      "X-User-Token": normalizedToken,
    },
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`落雪接口返回了无效数据（HTTP ${response.status}）`);
  }
  const envelope = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  if (!response.ok || envelope?.success === false) {
    const message = typeof envelope?.message === "string"
      ? envelope.message
      : typeof envelope?.code === "number"
        ? `错误码 ${envelope.code}`
        : `HTTP ${response.status}`;
    throw new Error(`落雪同步失败：${message}`);
  }
  return payload;
}
