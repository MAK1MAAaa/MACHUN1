import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const inputPath = process.argv[2];
if (!inputPath) {
  throw new Error("用法：node scripts/enrich-catalog-notes.mjs <music-ex.json>");
}

const difficultyPrefixes = {
  EXP: "lev_exp",
  MAS: "lev_mas",
  ULT: "lev_ult",
};

function parseCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : 0;
}

function parseBpm(value) {
  const values = String(value ?? "").match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const bpm = Math.max(...values.filter((item) => Number.isFinite(item) && item > 0));
  return Number.isFinite(bpm) ? bpm : null;
}

const catalogPath = resolve("src/data/catalog.json");
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const source = JSON.parse(await readFile(resolve(inputPath), "utf8"));
const songsById = new Map(source.map((song) => [String(song.id), song]));

const enriched = catalog.map((chart) => {
  const song = songsById.get(chart.id);
  const prefix = difficultyPrefixes[chart.difficulty];
  const bpm = song ? parseBpm(song.bpm) : null;
  if (!song || !prefix) {
    throw new Error(`无法补充谱面统计：${chart.id}:${chart.difficulty}`);
  }
  const notes = {
    total: parseCount(song[`${prefix}_notes`]),
    tap: parseCount(song[`${prefix}_notes_tap`]),
    hold: parseCount(song[`${prefix}_notes_hold`]),
    slide: parseCount(song[`${prefix}_notes_slide`]),
    air: parseCount(song[`${prefix}_notes_air`]),
    flick: parseCount(song[`${prefix}_notes_flick`]),
  };
  if (notes.total <= 0) {
    throw new Error(`谱面 Note 总数无效：${chart.id}:${chart.difficulty}`);
  }
  return { ...chart, bpm: bpm ?? chart.bpm, notes };
});

await writeFile(catalogPath, `${JSON.stringify(enriched, null, 2)}\n`, "utf8");
console.log(`已为 ${enriched.length} 张谱面补充 BPM 与 Note 构成：${catalogPath}`);
