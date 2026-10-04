import { chartKey, compareRatings } from "./b30";
import { normalizeSearchText } from "./search";
import { SCORE_SOURCE_LABELS } from "./sources";
import type { CatalogChart, Difficulty, ScoreSource, SingleRating } from "../types";

export const RECORDS_PAGE_SIZE = 10;

export type RecordsViewMode = "rating" | "catalog";
export type RecordsScoreSort = "default" | "descending" | "ascending";

export interface RecordsFilters {
  query: string;
  difficulty: Difficulty | "";
  level: string;
  constant: string;
  genre: string;
  version: string;
  includeUnplayed: boolean;
  source: ScoreSource | "";
  scoreSort: RecordsScoreSort;
}

export const EMPTY_RECORDS_FILTERS: RecordsFilters = {
  query: "",
  difficulty: "",
  level: "",
  constant: "",
  genre: "",
  version: "",
  includeUnplayed: false,
  source: "",
  scoreSort: "default",
};

export interface RecordsRow {
  chart: CatalogChart;
  record: SingleRating | undefined;
  rank: number | null;
}

export function getChartLevel(constant: number): string {
  // Mate display levels split at x.5; integer tenths avoid floating-point edge cases.
  const tenths = Math.round(constant * 10);
  return `${Math.floor(tenths / 10)}${tenths % 10 >= 5 ? "+" : ""}`;
}

export function getRecordsFilterOptions(charts: readonly CatalogChart[]): {
  levels: string[];
  constants: string[];
  genres: string[];
  versions: string[];
} {
  return {
    levels: [...new Set(charts.map((chart) => getChartLevel(chart.constant)))].sort((left, right) =>
      Number.parseInt(left) - Number.parseInt(right) || Number(left.endsWith("+")) - Number(right.endsWith("+"))),
    constants: [...new Set(charts.map((chart) => chart.constant.toFixed(1)))].sort((left, right) => Number(left) - Number(right)),
    genres: [...new Set(charts.map((chart) => chart.genre))].sort((left, right) => left.localeCompare(right, "en")),
    versions: [...new Set(charts.map((chart) => chart.version))].sort((left, right) => left.localeCompare(right, "en")),
  };
}

function matchesSearch(row: RecordsRow, query: string, nicknameOverrides: Record<string, string[]>): boolean {
  if (!query) return true;
  const { chart, record } = row;
  const text = [
    chart.id, chart.title, chart.difficulty, ...chart.nickname,
    ...(nicknameOverrides[chart.id] ?? []),
    record ? SCORE_SOURCE_LABELS[record.source] : "未游玩",
  ].join(" ");
  return normalizeSearchText(text).includes(query);
}

function compareCatalogRows(left: RecordsRow, right: RecordsRow, scoreSort: RecordsScoreSort): number {
  // A missing score is not a zero score and always follows played charts.
  if (Boolean(left.record) !== Boolean(right.record)) return left.record ? -1 : 1;
  if (scoreSort !== "default" && left.record && right.record) {
    const scoreDifference = left.record.score - right.record.score;
    if (scoreDifference) return scoreSort === "ascending" ? scoreDifference : -scoreDifference;
  }
  return right.chart.constant - left.chart.constant
    || left.chart.title.localeCompare(right.chart.title, "zh-CN")
    || chartKey(left.chart).localeCompare(chartKey(right.chart));
}

export function buildRecordsRows(
  charts: readonly CatalogChart[],
  records: readonly SingleRating[],
  scores: Record<string, SingleRating>,
  nicknameOverrides: Record<string, string[]>,
  mode: RecordsViewMode,
  filters: RecordsFilters,
): RecordsRow[] {
  const chartsByKey = new Map(charts.map((chart) => [chartKey(chart), chart]));
  const rankedRecords = records.filter((record) => chartsByKey.has(chartKey(record))).sort(compareRatings);
  const ranks = new Map(rankedRecords.map((record, index) => [chartKey(record), index + 1]));
  const query = normalizeSearchText(filters.query);
  if (mode === "rating") {
    return rankedRecords.map((record) => ({
      chart: chartsByKey.get(chartKey(record))!,
      record,
      rank: ranks.get(chartKey(record))!,
    })).filter((row) => matchesSearch(row, query, nicknameOverrides));
  }

  return charts
    .filter((chart) => (!filters.difficulty || chart.difficulty === filters.difficulty)
      && (!filters.level || getChartLevel(chart.constant) === filters.level)
      && (!filters.constant || chart.constant.toFixed(1) === filters.constant)
      && (!filters.genre || chart.genre === filters.genre)
      && (!filters.version || chart.version === filters.version))
    .map((chart) => ({ chart, record: scores[chartKey(chart)], rank: ranks.get(chartKey(chart)) ?? null }))
    .filter((row) => (filters.source
      ? row.record?.source === filters.source
      : filters.includeUnplayed || row.record !== undefined)
      && matchesSearch(row, query, nicknameOverrides))
    .sort((left, right) => compareCatalogRows(left, right, filters.scoreSort));
}

export function paginateRecords(rows: readonly RecordsRow[], requestedPage: number): {
  rows: RecordsRow[];
  page: number;
  pageCount: number;
  total: number;
} {
  const pageCount = Math.max(1, Math.ceil(rows.length / RECORDS_PAGE_SIZE));
  const page = Number.isFinite(requestedPage) ? Math.min(pageCount, Math.max(1, Math.floor(requestedPage))) : 1;
  const offset = (page - 1) * RECORDS_PAGE_SIZE;
  return { rows: rows.slice(offset, offset + RECORDS_PAGE_SIZE), page, pageCount, total: rows.length };
}
