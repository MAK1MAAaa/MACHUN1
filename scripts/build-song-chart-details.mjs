import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const inputPath = process.argv[2];
const cutoff = process.argv[3] ?? "2026-09-17";
if (!inputPath || !/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) {
  throw new Error("用法：node scripts/build-song-chart-details.mjs <music-ex.json> [YYYY-MM-DD]");
}

// Supplement the detail card without expanding the 13.0+ score catalog.
const catalog = JSON.parse(await readFile(resolve("src/data/catalog.json"), "utf8"));
const source = JSON.parse(await readFile(resolve(inputPath), "utf8"));
if (!Array.isArray(catalog) || !Array.isArray(source)) throw new Error("曲库与来源必须为数组");

const songsById = new Map(catalog.map((chart) => [chart.id, chart.title]));
const catalogKeys = new Set(catalog.map((chart) => `${chart.id}:${chart.difficulty}`));
const detailsByKey = new Map();
const fields = [["EXP", "lev_exp_i"], ["MAS", "lev_mas_i"], ["ULT", "lev_ult_i"]];
const cutoffDigits = cutoff.replaceAll("-", "");

for (const song of source) {
  if (!song || typeof song !== "object") continue;
  const id = String(song.id ?? "");
  const title = songsById.get(id);
  if (!title || typeof song.title !== "string" ||
      title.normalize("NFKC") !== song.title.normalize("NFKC")) continue;
  const date = String(song.date_added ?? "").replaceAll("-", "");
  if (/^\d{8}$/.test(date) && date > cutoffDigits) continue;

  for (const [difficulty, field] of fields) {
    const value = song[field];
    if (value == null || (typeof value === "string" && value.trim() === "")) continue;
    const constant = Number(value);
    const key = `${id}:${difficulty}`;
    if (!Number.isFinite(constant) || constant <= 0 || catalogKeys.has(key)) continue;
    const previous = detailsByKey.get(key);
    if (previous && previous.constant !== constant) throw new Error(`详情谱面定数冲突：${key}`);
    detailsByKey.set(key, { id, difficulty, constant });
  }
}

const order = new Map(fields.map(([difficulty], index) => [difficulty, index]));
const details = [...detailsByKey.values()].sort((left, right) =>
  left.id.localeCompare(right.id, "en", { numeric: true }) ||
  order.get(left.difficulty) - order.get(right.difficulty),
);
await writeFile(resolve("src/data/song-chart-details.json"), `${JSON.stringify(details, null, 2)}\n`, "utf8");
console.log(`已补充 ${details.length} 张详情谱面，评分曲库保持不变`);
