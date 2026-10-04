import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { mergeAliasesIntoCatalog } from "./catalog-aliases.mjs";

const inputPath = process.argv[2];
if (!inputPath) {
  throw new Error("用法：node scripts/merge-aliases.mjs <alias-list.json>");
}

const catalogPath = resolve("src/data/catalog.json");
const [catalog, payload] = await Promise.all([
  readFile(catalogPath, "utf8").then(JSON.parse),
  readFile(resolve(inputPath), "utf8").then(JSON.parse),
]);
let aliasPayload = payload;
if (!Array.isArray(payload?.aliases) && Array.isArray(payload?.songs)) {
  const idsByTitle = new Map();
  for (const chart of catalog) {
    const title = chart.title.normalize("NFKC").trim();
    const ids = idsByTitle.get(title) ?? new Set();
    ids.add(chart.id);
    idsByTitle.set(title, ids);
  }
  // Community lists use official music IDs; legacy lists use exact song titles.
  aliasPayload = {
    aliases: payload.songs.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || !Array.isArray(entry.aliases)) return [];
      const cid = String(entry.cid ?? "").normalize("NFKC").trim();
      if (/^\d+$/.test(cid)) return [{ song_id: String(Number(cid)), aliases: entry.aliases }];
      const ids = idsByTitle.get(cid);
      if (ids?.size !== 1) return [];
      return [{ song_id: [...ids][0], aliases: entry.aliases }];
    }),
  };
}
const result = mergeAliasesIntoCatalog(catalog, aliasPayload);

await writeFile(catalogPath, `${JSON.stringify(result.catalog, null, 2)}\n`, "utf8");
console.log(
  `已写入 ${result.stats.aliasCount} 个别名，覆盖 ${result.stats.songsWithAliases} 首歌曲，匹配 ${result.stats.matchedSongs} 个来源 ID：${catalogPath}`,
);
