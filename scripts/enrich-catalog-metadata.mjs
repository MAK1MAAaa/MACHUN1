import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { enrichCatalogMetadata } from "./catalog-metadata.mjs";

const inputPath = process.argv[2];
if (!inputPath) {
  throw new Error("用法：node scripts/enrich-catalog-metadata.mjs <music-ex.json>");
}

const catalogPath = resolve("src/data/catalog.json");
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const source = JSON.parse(await readFile(resolve(inputPath), "utf8"));
const result = enrichCatalogMetadata(catalog, source);

await writeFile(catalogPath, `${JSON.stringify(result.catalog, null, 2)}\n`, "utf8");
console.log(`已为 ${result.catalog.length} 张谱面补充分类与歌曲初出版本，未知 ${result.stats.unknownCharts} 张谱面 / ${result.stats.unknownSongs} 首歌曲：${catalogPath}`);
