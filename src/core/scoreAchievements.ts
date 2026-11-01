import { CLEAR_STATUSES, type ClearStatus, type ComboStatus, type FullChainStatus, type ScoreAchievements } from "../types";

const COMBO_ORDER: Record<ComboStatus, number> = { fc: 1, aj: 2, ajc: 3 };
const CHAIN_ORDER: Record<FullChainStatus, number> = { fchain: 1, gold: 2, platinum: 3 };
const CLEAR_ORDER: Record<ClearStatus, number> = { failed: 0, clear: 1, hard: 2, brave: 3, absolute: 4, catastrophy: 5 };

export const CLEAR_LABELS: Record<ClearStatus, string> = {
  failed: "FAILED", clear: "CLEAR", hard: "HARD", brave: "BRAVE", absolute: "ABSOLUTE", catastrophy: "CATASTROPHY",
};

export const COMBO_LABELS: Record<ComboStatus, string> = { fc: "FC", aj: "AJ", ajc: "AJC" };
export const COMBO_DESCRIPTIONS: Record<ComboStatus, string> = {
  fc: "FULL COMBO",
  aj: "ALL JUSTICE",
  ajc: "ALL JUSTICE CRITICAL",
};
export const CHAIN_LABELS: Record<FullChainStatus, string> = {
  fchain: "FCHAIN", gold: "金 FCHAIN", platinum: "铂 FCHAIN",
};

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/[\s_-]/g, "") : "";
}

function parseCombo(value: unknown): ComboStatus | undefined {
  const text = normalizedText(value);
  if (text === "fc" || text === "fullcombo") return "fc";
  if (text === "aj" || text === "alljustice") return "aj";
  if (text === "ajc" || text === "alljusticecritical") return "ajc";
  return undefined;
}

function parseChain(value: unknown): FullChainStatus | undefined {
  const text = normalizedText(value);
  if (text === "fchain") return "fchain";
  if (text === "gold" || text === "fullchain2") return "gold";
  if (text === "platinum" || text === "fullchain") return "platinum";
  return undefined;
}

function parseClear(value: unknown): ClearStatus | undefined {
  const text = normalizedText(value);
  if (text === "catastrophe") return "catastrophy";
  return CLEAR_STATUSES.includes(text as ClearStatus) ? text as ClearStatus : undefined;
}

function clearFlag(value: unknown): ClearStatus | undefined {
  if (value === true || value === 1 || normalizedText(value) === "true" || normalizedText(value) === "1") return "clear";
  if (value === false || value === 0 || normalizedText(value) === "false" || normalizedText(value) === "0") return "failed";
  return undefined;
}

function flag(record: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.some((field) => record[field] === true || record[field] === 1
    || normalizedText(record[field]) === "1" || normalizedText(record[field]) === "true");
}

/** Achievement lamps are earned independently of the run that set the highest score. */
export function mergeScoreAchievements(a: ScoreAchievements, b: ScoreAchievements): ScoreAchievements {
  const combo = a.combo && (!b.combo || COMBO_ORDER[a.combo] >= COMBO_ORDER[b.combo]) ? a.combo : b.combo;
  const fullChain = a.fullChain && (!b.fullChain || CHAIN_ORDER[a.fullChain] >= CHAIN_ORDER[b.fullChain]) ? a.fullChain : b.fullChain;
  const aClear = parseClear(a.clear);
  const bClear = parseClear(b.clear);
  const clear = aClear && (!bClear || CLEAR_ORDER[aClear] >= CLEAR_ORDER[bClear]) ? aClear : bClear;
  return { ...(combo ? { combo } : {}), ...(fullChain ? { fullChain } : {}), ...(clear ? { clear } : {}) };
}

/** Normalize only score metadata; account data never enters a normalized score record. */
export function readScoreAchievements(record: Record<string, unknown>, score?: number): ScoreAchievements {
  let result: ScoreAchievements = {};
  for (const field of ["combo", "full_combo", "fullCombo", "fc"]) {
    result = mergeScoreAchievements(result, { combo: parseCombo(record[field]) });
  }
  if (flag(record, ["isFullCombo", "is_full_combo"])) result = mergeScoreAchievements(result, { combo: "fc" });
  if (flag(record, ["isAllJustice", "is_all_justice"])) result = mergeScoreAchievements(result, { combo: "aj" });
  // A perfect CHUNITHM score implies AJC, including older exports that only have FC/AJ booleans.
  if (score === 1_010_000 || flag(record, ["isAllJusticeCritical", "is_all_justice_critical", "isAjc", "isAJC", "is_ajc"])) {
    result = mergeScoreAchievements(result, { combo: "ajc" });
  }
  for (const field of ["fullChain", "full_chain"]) {
    result = mergeScoreAchievements(result, { fullChain: parseChain(record[field]) });
  }
  // A boolean confirms a chain without specifying whether it is gold or platinum.
  if (flag(record, ["isFullChain", "is_full_chain"])) result = mergeScoreAchievements(result, { fullChain: "fchain" });
  // Skill clear lamps are explicit metadata, not score thresholds. Numeric portal
  // enums are intentionally ignored until their source-specific mapping is known.
  for (const field of ["clear", "clear_status", "clearStatus", "clear_type", "clearType", "clearMax", "clear_max"]) {
    result = mergeScoreAchievements(result, { clear: parseClear(record[field]) });
  }
  for (const field of ["isClear", "is_clear", "isSuccess", "is_success"]) result = mergeScoreAchievements(result, { clear: clearFlag(record[field]) });
  if (typeof record.clear === "boolean") result = mergeScoreAchievements(result, { clear: clearFlag(record.clear) });
  return result;
}
