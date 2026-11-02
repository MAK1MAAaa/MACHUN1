import type { CatalogChart, Difficulty, SingleRating } from "../types";
import { chartKey } from "./b30";
import { getAvailableChartConstants, getChartLevel } from "./recordsView";
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
export const CONSTANT_TABLE_LAMP_LABELS: Record<ConstantTableLamp, string> = {
  unplayed: "未游玩", clear: "CLEAR", fc: "FULL COMBO", aj: "ALL JUSTICE", ajc: "AJC",
};

/** This table's four visual achievement groups do not change source clear lamps. */
export function constantTableLamp(record: SingleRating | undefined): ConstantTableLamp {
  return record?.combo ?? (record ? "clear" : "unplayed");
}

function tenths(constant: string): number {
  if (!/^\d{1,2}\.\d$/.test(constant)) throw new Error("定数格式无效。");
  return Math.round(Number(constant) * 10);
}

export function validateConstantSelection(constants: readonly string[], availableConstants?: readonly string[]): string[] {
  if (!constants.length) throw new Error("请至少选择一个定数。");
  const values = [...new Set(constants.map(tenths))].sort((a, b) => a - b);
  if (values.length > MAX_CONSTANT_TABLE_SELECTION || values.at(-1)! - values[0] >= MAX_CONSTANT_TABLE_SELECTION) {
    throw new Error("最多选择连续 5 档定数，跨度不超过 0.4。");
  }
  if (availableConstants) {
    const available = [...new Set(availableConstants.map(tenths))].sort((left, right) => left - right);
    if (values.some(value => !available.includes(value))) throw new Error("选择中包含当前条件下不存在的定数。");
    if (available.filter(value => value >= values[0] && value <= values.at(-1)!).length !== values.length) throw new Error("定数必须按当前可用选项连续选择。");
  } else if (values.at(-1)! - values[0] + 1 !== values.length) throw new Error("定数必须连续选择。");
  return values.map(value => (value / 10).toFixed(1));
}

/** Drop hidden values and fill the interval using only current options, never synthetic tenths. */
export function reconcileConstantSelection(current: readonly string[], availableConstants: readonly string[]): string[] {
  const available = new Set(availableConstants);
  const values = [...new Set(current.filter(value => available.has(value)).map(tenths))].sort((left, right) => left - right);
  if (!values.length) return [];
  // Bound recovery from stale state as well as ordinary selections.
  const windows = values.map(start => values.filter(value => value >= start && value < start + MAX_CONSTANT_TABLE_SELECTION));
  const kept = windows.sort((left, right) => right.length - left.length || left[0] - right[0])[0];
  return [...new Set(availableConstants.map(tenths))].filter(value => value >= kept[0] && value <= kept.at(-1)!)
    .sort((left, right) => left - right).map(value => (value / 10).toFixed(1));
}

/** Selecting an endpoint fills only existing values; an unavailable gap cannot become hidden state. */
export function toggleConstantSelection(current: readonly string[], constant: string, availableConstants?: readonly string[]): string[] {
  const value = tenths(constant);
  if (availableConstants && !availableConstants.includes(constant)) throw new Error("当前筛选条件下没有这个定数。");
  if (availableConstants) current = reconcileConstantSelection(current, availableConstants);
  if (!current.length) return [(value / 10).toFixed(1)];
  const selected = validateConstantSelection(current, availableConstants);
  const values = selected.map(tenths);
  if (values.includes(value)) {
    if (value !== values[0] && value !== values.at(-1)) throw new Error("只能移除区间两端的定数，以保持连续。");
    return selected.filter(item => tenths(item) !== value);
  }
  const minimum = Math.min(value, values[0]);
  const maximum = Math.max(value, values.at(-1)!);
  if (maximum - minimum >= MAX_CONSTANT_TABLE_SELECTION) throw new Error("最多选择连续 5 档定数，请先清空定数或缩小区间。");
  return availableConstants
    ? [...new Set(availableConstants.map(tenths))].filter(value => value >= minimum && value <= maximum)
      .sort((left, right) => left - right).map(value => (value / 10).toFixed(1))
    : Array.from({ length: maximum - minimum + 1 }, (_, index) => ((minimum + index) / 10).toFixed(1));
}

const difficultyOrder: Record<Difficulty, number> = { ULT: 0, MAS: 1, EXP: 2 };

export function buildConstantTableGroups(
  charts: readonly CatalogChart[],
  scores: Readonly<Record<string, SingleRating>>,
  filters: ConstantTableFilters,
): ConstantTableGroup[] {
  const available = getAvailableChartConstants(charts, filters);
  const selected = reconcileConstantSelection(filters.constants, available);
  if (!selected.length) return [];
  const constants = validateConstantSelection(selected, available);
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
