function normalizeValue(value) {
  return String(value).normalize("NFKC").trim();
}

function aliasKey(value) {
  return normalizeValue(value).toLocaleLowerCase();
}

function appendAliases(target, seen, values, title, songId) {
  const excluded = new Set([aliasKey(title), aliasKey(songId)]);

  for (const value of values ?? []) {
    if (typeof value !== "string") continue;
    const alias = normalizeValue(value);
    const key = aliasKey(alias);
    if (!alias || excluded.has(key) || seen.has(key)) continue;
    seen.add(key);
    target.push(alias);
  }
}

export function mergeAliasesIntoCatalog(catalog, payload) {
  if (!Array.isArray(catalog)) {
    throw new Error("曲库必须是数组");
  }
  if (!payload || !Array.isArray(payload.aliases)) {
    throw new Error("别名文件格式错误：缺少 aliases 数组");
  }

  const songTitles = new Map();
  for (const chart of catalog) {
    songTitles.set(String(chart.id), String(chart.title));
  }

  const aliasesBySong = new Map();
  const seenBySong = new Map();
  const ensureSong = (songId) => {
    if (!aliasesBySong.has(songId)) {
      aliasesBySong.set(songId, []);
      seenBySong.set(songId, new Set());
    }
  };

  for (const chart of catalog) {
    const songId = String(chart.id);
    ensureSong(songId);
    appendAliases(
      aliasesBySong.get(songId),
      seenBySong.get(songId),
      chart.nickname,
      songTitles.get(songId),
      songId,
    );
  }

  const matchedSongIds = new Set();
  for (const entry of payload.aliases) {
    if (!entry || typeof entry !== "object") continue;
    const songId = normalizeValue(entry.song_id);
    if (!songTitles.has(songId) || !Array.isArray(entry.aliases)) continue;
    matchedSongIds.add(songId);
    appendAliases(
      aliasesBySong.get(songId),
      seenBySong.get(songId),
      entry.aliases,
      songTitles.get(songId),
      songId,
    );
  }

  const mergedCatalog = catalog.map((chart) => ({
    ...chart,
    nickname: [...(aliasesBySong.get(String(chart.id)) ?? [])],
  }));
  const songsWithAliases = [...aliasesBySong.values()].filter((aliases) => aliases.length > 0).length;
  const aliasCount = [...aliasesBySong.values()].reduce((total, aliases) => total + aliases.length, 0);

  return {
    catalog: mergedCatalog,
    stats: {
      matchedSongs: matchedSongIds.size,
      songsWithAliases,
      aliasCount,
    },
  };
}
