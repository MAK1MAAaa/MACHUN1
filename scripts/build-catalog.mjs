import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { mergeAliasesIntoCatalog } from "./catalog-aliases.mjs";
import { songMetadata } from "./catalog-metadata.mjs";

const inputPath = process.argv[2];
const aliasesPath = process.argv[3];
if (!inputPath) {
  throw new Error("用法：node scripts/build-catalog.mjs <music-ex.json> [lxns-alias-list.json]");
}

const difficultyFields = [
  ["EXP", "lev_exp_i"],
  ["MAS", "lev_mas_i"],
  ["ULT", "lev_ult_i"],
];
const coverBaseUrl = "https://otoge-db.net/chunithm/jacket/";
const minimumConstant = 13;

function parseCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : 0;
}

function parseBpm(value) {
  const values = String(value ?? "").match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const bpm = Math.max(...values.filter((item) => Number.isFinite(item) && item > 0));
  return Number.isFinite(bpm) ? bpm : null;
}

const source = JSON.parse(await readFile(resolve(inputPath), "utf8"));
const catalog = [];

for (const song of source) {
  if (!song || typeof song !== "object" || !song.id || !song.title) continue;
  const image = typeof song.image === "string" ? song.image.normalize("NFKC").trim() : "";
  for (const [difficulty, field] of difficultyFields) {
    const constant = Number(song[field]);
    if (!Number.isFinite(constant) || constant < minimumConstant) continue;
    if (!image) throw new Error(`歌曲 ${song.id}《${song.title}》缺少曲绘文件名`);
    const prefix = field.replace(/_i$/, "");
    const bpm = parseBpm(song.bpm);

    catalog.push({
      id: String(song.id),
      title: String(song.title),
      difficulty,
      constant,
      ...songMetadata(song),
      nickname: [],
      coverUrl: `${coverBaseUrl}${encodeURIComponent(image)}`,
      bpm,
      notes: {
        total: parseCount(song[`${prefix}_notes`]),
        tap: parseCount(song[`${prefix}_notes_tap`]),
        hold: parseCount(song[`${prefix}_notes_hold`]),
        slide: parseCount(song[`${prefix}_notes_slide`]),
        air: parseCount(song[`${prefix}_notes_air`]),
        flick: parseCount(song[`${prefix}_notes_flick`]),
      },
    });
  }
}

catalog.sort((left, right) =>
  right.constant - left.constant ||
  left.title.localeCompare(right.title, "ja") ||
  left.difficulty.localeCompare(right.difficulty),
);

const seen = new Set();
for (const chart of catalog) {
  const key = `${chart.id}:${chart.difficulty}`;
  if (seen.has(key)) throw new Error(`重复谱面：${key}`);
  seen.add(key);
}

const outputPath = resolve("src/data/catalog.json");
let outputCatalog = catalog;
let aliasSummary = "";

if (aliasesPath) {
  const aliasesPayload = JSON.parse(await readFile(resolve(aliasesPath), "utf8"));
  const result = mergeAliasesIntoCatalog(catalog, aliasesPayload);
  outputCatalog = result.catalog;
  aliasSummary = `，包含 ${result.stats.aliasCount} 个别名，覆盖 ${result.stats.songsWithAliases} 首歌曲`;
}

await writeFile(outputPath, `${JSON.stringify(outputCatalog, null, 2)}\n`, "utf8");
console.log(`已生成 ${outputCatalog.length} 张谱面${aliasSummary}：${outputPath}`);
