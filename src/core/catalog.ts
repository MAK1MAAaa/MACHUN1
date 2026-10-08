import catalogData from "../data/catalog.json";
import type { CatalogChart, Difficulty } from "../types";

export let CATALOG_DATE = "2026-10-08";
export let CATALOG_VERSION = `Mate-${CATALOG_DATE}-13plus`;

function isDifficulty(value: unknown): value is Difficulty {
  return value === "EXP" || value === "MAS" || value === "ULT";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isCatalogChart(value: unknown): value is CatalogChart {
  if (!value || typeof value !== "object") return false;
  const chart = value as Record<string, unknown>;
  return (
    typeof chart.id === "string" &&
    chart.id.length > 0 &&
    typeof chart.title === "string" &&
    chart.title.length > 0 &&
    isDifficulty(chart.difficulty) &&
    typeof chart.constant === "number" &&
    Number.isFinite(chart.constant) &&
    chart.constant >= 13 &&
    typeof chart.genre === "string" &&
    chart.genre.trim().length > 0 &&
    typeof chart.version === "string" &&
    chart.version.trim().length > 0 &&
    Array.isArray(chart.nickname) &&
    chart.nickname.every((nickname) => typeof nickname === "string") &&
    typeof chart.coverUrl === "string" &&
    /^https:\/\//.test(chart.coverUrl) &&
    (chart.bpm === null || (typeof chart.bpm === "number" && Number.isFinite(chart.bpm) && chart.bpm > 0)) &&
    typeof chart.notes === "object" &&
    chart.notes !== null &&
    isNonNegativeInteger((chart.notes as Record<string, unknown>).total) &&
    isNonNegativeInteger((chart.notes as Record<string, unknown>).tap) &&
    isNonNegativeInteger((chart.notes as Record<string, unknown>).hold) &&
    isNonNegativeInteger((chart.notes as Record<string, unknown>).slide) &&
    isNonNegativeInteger((chart.notes as Record<string, unknown>).air) &&
    isNonNegativeInteger((chart.notes as Record<string, unknown>).flick)
  );
}

export function validateCatalog(value: unknown): CatalogChart[] {
  if (!Array.isArray(value)) {
    throw new Error("曲库格式无效");
  }

  const seen = new Set<string>();
  return value.map((item) => {
    if (!isCatalogChart(item)) {
      throw new Error("曲库包含无效谱面");
    }
    const key = `${item.id}:${item.difficulty}`;
    if (seen.has(key)) {
      throw new Error(`曲库包含重复谱面：${key}`);
    }
    seen.add(key);
    return item;
  });
}

export let catalog = validateCatalog(catalogData);

export let catalogByKey: Map<string, CatalogChart> = new Map(
  catalog.map((chart) => [`${chart.id}:${chart.difficulty}`, chart] as const),
);

/** Install the authenticated database snapshot before mounting the workspace. */
export function installCatalogSnapshot(snapshot: { date: string; version: string; charts: CatalogChart[] }): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot.date) || typeof snapshot.version !== "string" || !snapshot.version) throw new Error("曲库版本无效");
  const validated = validateCatalog(snapshot.charts);
  if (!validated.length) throw new Error("数据库曲库为空");
  catalog = validated;
  catalogByKey = new Map(catalog.map(chart => [`${chart.id}:${chart.difficulty}`, chart]));
  CATALOG_DATE = snapshot.date;
  CATALOG_VERSION = snapshot.version;
}
