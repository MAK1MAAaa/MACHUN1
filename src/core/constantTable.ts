import type { CatalogChart, Difficulty, SingleRating } from "../types";
import { chartKey } from "./b30";
import { getChartLevel } from "./recordsView";
import { getChartReleaseDate } from "./chartReleaseDates";

export const MAX_CONSTANT_TABLE_SELECTION = 5;
export const CONSTANT_TABLE_DIFFICULTY_COLORS: Record<Difficulty, string> = {
  ULT: "#26212e", MAS: "#8b4bb7", EXP: "#dd2636",
};
export const CONSTANT_TABLE_AJ_COLORS = ["#f3a5bc", "#ffe08c", "#b0e0a1", "#9dc9ef", "#c7a5e8"] as const;
export const CONSTANT_TABLE_AJC_COLORS = ["#dc7097", "#e2b64e", "#74b76d", "#5998cf", "#a179ca"] as const;

export interface ConstantTableFilters {
  difficulty: Difficulty | "";
  level: string;
  constants: string[];
  genre: string;
  version: string;
}

export const DEFAULT_CONSTANT_TABLE_FILTERS: ConstantTableFilters = {
  difficulty: "", level: "", constants: ["14.0"], genre: "", version: "",
};

export interface ConstantTableEntry {
  chart: CatalogChart;
  record: SingleRating | undefined;
  releaseDate: string | null;
}

export interface ConstantTableGroup {
  constant: string;
  entries: ConstantTableEntry[];
}

export type ConstantTableLamp = "unplayed" | "clear" | "fc" | "aj" | "ajc";

/** This table's four visual achievement groups do not change source clear lamps. */
export function constantTableLamp(record: SingleRating | undefined): ConstantTableLamp {
  return record?.combo ?? (record ? "clear" : "unplayed");
}

function tenths(constant: string): number {
  if (!/^\d{1,2}\.\d$/.test(constant)) throw new Error("定数格式无效。");
  return Math.round(Number(constant) * 10);
}

export function validateConstantSelection(constants: readonly string[]): string[] {
  if (!constants.length) throw new Error("请至少选择一个定数。");
  const values = [...new Set(constants.map(tenths))].sort((a, b) => a - b);
  if (values.length > MAX_CONSTANT_TABLE_SELECTION || values.at(-1)! - values[0] >= MAX_CONSTANT_TABLE_SELECTION) {
    throw new Error("最多选择连续 5 档定数，跨度不超过 0.4。");
  }
  if (values.at(-1)! - values[0] + 1 !== values.length) throw new Error("定数必须连续选择。");
  return values.map(value => (value / 10).toFixed(1));
}

/** Selecting an endpoint fills its interval; removing an interior item would create a gap. */
export function toggleConstantSelection(current: readonly string[], constant: string): string[] {
  const value = tenths(constant);
  if (!current.length) return [(value / 10).toFixed(1)];
  const selected = validateConstantSelection(current);
  const values = selected.map(tenths);
  if (values.includes(value)) {
    if (value !== values[0] && value !== values.at(-1)) throw new Error("只能移除区间两端的定数，以保持连续。");
    return selected.filter(item => tenths(item) !== value);
  }
  const minimum = Math.min(value, values[0]);
  const maximum = Math.max(value, values.at(-1)!);
  if (maximum - minimum >= MAX_CONSTANT_TABLE_SELECTION) throw new Error("最多选择连续 5 档定数，请先清空定数或缩小区间。");
  return Array.from({ length: maximum - minimum + 1 }, (_, index) => ((minimum + index) / 10).toFixed(1));
}

const difficultyOrder: Record<Difficulty, number> = { ULT: 0, MAS: 1, EXP: 2 };

export function buildConstantTableGroups(
  charts: readonly CatalogChart[],
  scores: Readonly<Record<string, SingleRating>>,
  filters: ConstantTableFilters,
): ConstantTableGroup[] {
  const constants = validateConstantSelection(filters.constants);
  const groups = new Map(constants.map(constant => [constant, [] as ConstantTableEntry[]]));
  for (const chart of charts) {
    if (!groups.has(chart.constant.toFixed(1))
      || (filters.difficulty && chart.difficulty !== filters.difficulty)
      || (filters.level && getChartLevel(chart.constant) !== filters.level)
      || (filters.genre && chart.genre !== filters.genre)
      || (filters.version && chart.version !== filters.version)) continue;
    groups.get(chart.constant.toFixed(1))!.push({ chart, record: scores[chartKey(chart)], releaseDate: getChartReleaseDate(chart) });
  }
  return [...groups].reverse().map(([constant, entries]) => ({
    constant,
    entries: entries.sort((left, right) => difficultyOrder[left.chart.difficulty] - difficultyOrder[right.chart.difficulty]
      || (left.releaseDate ?? "9999-12-31").localeCompare(right.releaseDate ?? "9999-12-31")
      || left.chart.id.localeCompare(right.chart.id, "en", { numeric: true })
      || chartKey(left.chart).localeCompare(chartKey(right.chart))),
  }));
}
