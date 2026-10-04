const versionNames = new Map([
  ["無印", "CHUNITHM"],
  ["Mate", "MATE"],
  // OTOGE DB's PARADISE× songs match the 2021-05-13 PARADISE LOST release.
  // https://chunithm.sega.jp/news/2021-05-13/
  ["PARADISE×", "PARADISE LOST"],
]);

function metadataText(value) {
  return typeof value === "string" ? value.normalize("NFKC").trim() : "";
}

export function songMetadata(song) {
  const rawVersion = metadataText(song?.version);
  return {
    genre: metadataText(song?.catname) || "Unknown",
    // version belongs to the song, rather than a difficulty added later.
    version: versionNames.get(rawVersion) || rawVersion.replace(/\+$/, " PLUS") || "Unknown",
  };
}

export function enrichCatalogMetadata(catalog, source) {
  if (!Array.isArray(catalog) || !Array.isArray(source)) {
    throw new Error("曲库和 OTOGE DB 数据必须是数组");
  }

  const requestedIds = new Set(catalog.map((chart) => String(chart.id)));
  const songsById = new Map();
  for (const song of source) {
    if (!song || typeof song !== "object" || !song.id || !song.title) continue;
    const id = String(song.id);
    // WORLD'S END can reuse an ID across releases; it is outside this catalog.
    if (!requestedIds.has(id)) continue;
    const previous = songsById.get(id);
    if (previous && (
      metadataText(previous.title) !== metadataText(song.title) ||
      JSON.stringify(songMetadata(previous)) !== JSON.stringify(songMetadata(song))
    )) {
      throw new Error(`OTOGE DB 歌曲 ID 存在冲突：${id}`);
    }
    songsById.set(id, song);
  }

  let unknownCharts = 0;
  const unknownSongs = new Set();
  const enriched = catalog.map((chart) => {
    const song = songsById.get(String(chart.id));
    if (song && metadataText(song.title) !== metadataText(chart.title)) {
      throw new Error(`歌曲 ID 与曲名不匹配：${chart.id}《${chart.title}》`);
    }
    const metadata = songMetadata(song);
    if (metadata.genre === "Unknown" || metadata.version === "Unknown") {
      unknownCharts += 1;
      unknownSongs.add(String(chart.id));
    }
    return { ...chart, ...metadata };
  });

  return { catalog: enriched, stats: { unknownCharts, unknownSongs: unknownSongs.size } };
}
