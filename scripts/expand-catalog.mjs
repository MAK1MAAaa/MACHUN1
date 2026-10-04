import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { mergeAliasesIntoCatalog } from "./catalog-aliases.mjs";
import { songMetadata } from "./catalog-metadata.mjs";

const inputPath = process.argv[2];
const aliasesPath = process.argv[3];
const cutoff = process.argv[4] ?? "2026-09-17";
if (!inputPath || !/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) {
  throw new Error("用法：node scripts/expand-catalog.mjs <music-ex.json> [lxns-alias-list.json] [YYYY-MM-DD]");
}

// The OTOGE DB row has no EXP notes yet. These counts are recorded by the
// chart-research contributors at https://wikiwiki.jp/chunithmwiki/Prismatic%20Theory.
const supplements = new Map([
  ["3043:EXP", {
    bpm: 148,
    notes: { total: 1433, tap: 732, hold: 111, slide: 431, air: 159, flick: 0 },
  }],
  // https://wikiwiki.jp/chunithmwiki/The%20Disaster%20of%20Passion
  ["3050:MAS", { bpm: 180 }],
]);
const difficultyFields = [["EXP", "lev_exp_i"], ["MAS", "lev_mas_i"], ["ULT", "lev_ult_i"]];
const outputPath = resolve("src/data/catalog.json");
const existing = JSON.parse(await readFile(outputPath, "utf8"));
const source = JSON.parse(await readFile(resolve(inputPath), "utf8"));
if (!Array.isArray(existing) || !Array.isArray(source)) throw new Error("曲库与来源必须为数组");

const seen = new Set(existing.map((chart) => `${chart.id}:${chart.difficulty}`));
if (seen.size !== existing.length) throw new Error("原曲库包含重复谱面");
const existingSongs = new Map(existing.map((chart) => [String(chart.id), chart]));
const additions = [];
const cutoffDigits = cutoff.replaceAll("-", "");

function parseCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : 0;
}

function parseBpm(value) {
  const values = String(value ?? "").match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const bpm = Math.max(...values.filter((item) => Number.isFinite(item) && item > 0));
  return Number.isFinite(bpm) ? bpm : null;
}

for (const song of source) {
  if (!song || typeof song !== "object" || !song.id || !song.title) continue;
  const date = String(song.date_added ?? "").replaceAll("-", "");
  if (/^\d{8}$/.test(date) && date > cutoffDigits) continue;
  const id = String(song.id);
  const previous = existingSongs.get(id);
  if (previous && previous.title.normalize("NFKC") !== String(song.title).normalize("NFKC")) {
    throw new Error(`歌曲 ID 与原曲名冲突：${id}`);
  }
  const metadata = previous
    ? { genre: previous.genre, version: previous.version }
    : songMetadata(song);
  for (const [difficulty, field] of difficultyFields) {
    const constant = Number(song[field]);
    const key = `${id}:${difficulty}`;
    if (!Number.isFinite(constant) || constant < 13 || constant >= 14 || seen.has(key)) continue;
    const image = typeof song.image === "string" ? song.image.normalize("NFKC").trim() : "";
    if (!image || metadata.genre === "Unknown" || metadata.version === "Unknown") {
      throw new Error(`新增谱面缺少曲绘或分类版本：${key}`);
    }
    const prefix = field.replace(/_i$/, "");
    const supplement = supplements.get(key);
    const notes = supplement?.notes ?? {
      total: parseCount(song[`${prefix}_notes`]),
      tap: parseCount(song[`${prefix}_notes_tap`]),
      hold: parseCount(song[`${prefix}_notes_hold`]),
      slide: parseCount(song[`${prefix}_notes_slide`]),
      air: parseCount(song[`${prefix}_notes_air`]),
      flick: parseCount(song[`${prefix}_notes_flick`]),
    };
    if (notes.total <= 0) throw new Error(`新增谱面缺少总物量：${key}`);
    additions.push({
      id,
      title: previous?.title ?? String(song.title),
      difficulty,
      constant,
      ...metadata,
      nickname: previous ? [...previous.nickname] : [],
      coverUrl: previous?.coverUrl ?? `https://otoge-db.net/chunithm/jacket/${encodeURIComponent(image)}`,
      bpm: supplement?.bpm ?? parseBpm(song.bpm),
      notes,
    });
    seen.add(key);
  }
}

additions.sort((left, right) =>
  right.constant - left.constant ||
  left.title.localeCompare(right.title, "ja") ||
  left.difficulty.localeCompare(right.difficulty),
);

let merged = additions;
if (aliasesPath) {
  const payload = JSON.parse(await readFile(resolve(aliasesPath), "utf8"));
  merged = mergeAliasesIntoCatalog(additions, payload).catalog.map((chart) => {
    const previous = existingSongs.get(chart.id);
    // Do not change existing aliases while expanding the range.
    return previous ? { ...chart, nickname: [...previous.nickname] } : chart;
  });
}

// Append only. Existing chart values and ordering remain exactly as stored.
const expanded = [...existing, ...merged];
await writeFile(outputPath, `${JSON.stringify(expanded, null, 2)}\n`, "utf8");
console.log(`截至 ${cutoff}，新增 ${merged.length} 张谱面，合计 ${expanded.length} 张、${new Set(expanded.map((chart) => chart.id)).size} 首歌曲`);
