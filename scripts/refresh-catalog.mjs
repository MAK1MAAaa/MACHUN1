import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { songMetadata } from './catalog-metadata.mjs';

export const OCTOBER_SUPPLEMENTS = [
  { id: '3052', title: '雑魚', difficulty: 'MAS', constant: 13.1 },
  { id: '3054', title: '風呂入るプロファイル', difficulty: 'MAS', constant: 13.0 },
  { id: '3055', title: 'SAN値直葬', difficulty: 'MAS', constant: 15.1 },
  { id: '3055', title: 'SAN値直葬', difficulty: 'EXP', constant: 12.5 },
  { id: '3064', title: 'ハイボルテージガール', difficulty: 'MAS', constant: 14.1 },
  { id: '3064', title: 'ハイボルテージガール', difficulty: 'EXP', constant: 11.9 },
  { id: '3062', title: 'コンクエスト・チャレンジ', difficulty: 'MAS', constant: 14.7 },
  { id: '3062', title: 'コンクエスト・チャレンジ', difficulty: 'EXP', constant: 11.3 },
];
const fields = [['EXP', 'lev_exp'], ['MAS', 'lev_mas'], ['ULT', 'lev_ult']];
const zeroNotes = { total: 0, tap: 0, hold: 0, slide: 0, air: 0, flick: 0 };
const number = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;

export function refreshCatalog(existing, details, upstream, official, cutoff = '2026-10-08') {
  const songs = new Map(official.map(song => [String(song.id), song]));
  const overrides = new Map(OCTOBER_SUPPLEMENTS.map(row => [`${row.id}:${row.difficulty}`, row]));
  for (const row of OCTOBER_SUPPLEMENTS) {
    if (songs.get(row.id)?.title !== row.title) throw new Error(`官方编号与补充曲名不匹配：${row.id}`);
  }
  const originals = new Map(existing.map(chart => [`${chart.id}:${chart.difficulty}`, chart]));
  const bySong = new Map(existing.map(chart => [chart.id, chart]));
  const output = new Map(originals);
  const detailOutput = new Map(details.map(chart => [`${chart.id}:${chart.difficulty}`, chart]));
  const source = new Map(upstream.filter(song => !song.we_kanji && song.title).map(song => [String(song.id), song]));
  for (const row of OCTOBER_SUPPLEMENTS) {
    if (!source.has(row.id)) source.set(row.id, { ...songs.get(row.id), version: 'Mate', date_added: '20261008' });
  }
  for (const [id, raw] of source) {
    if (!songs.has(id)) continue;
    const date = String(raw.date_added ?? '').replaceAll('-', '');
    if (/^\d{8}$/.test(date) && date > cutoff.replaceAll('-', '')) continue;
    const canonical = songs.get(id);
    const previousSong = bySong.get(id);
    if (previousSong && previousSong.title.normalize('NFKC') !== canonical.title.normalize('NFKC')) throw new Error(`歌曲 ID 冲突：${id}`);
    for (const [difficulty, prefix] of fields) {
      if (!canonical[prefix]) continue;
      const key = `${id}:${difficulty}`;
      const constant = overrides.get(key)?.constant ?? number(raw[`${prefix}_i`]);
      if (constant === null) continue;
      if (constant < 13) {
        if (previousSong || [...overrides.values()].some(row => row.id === id)) detailOutput.set(key, { id, difficulty, constant });
        continue;
      }
      const previous = originals.get(key);
      const metadata = songMetadata(raw);
      const total = number(raw[`${prefix}_notes`]);
      const notes = total ? Object.fromEntries(Object.keys(zeroNotes).map(kind => [kind, Math.max(0, Number(raw[`${prefix}_notes${kind === 'total' ? '' : `_${kind}`}`]) || 0)])) : previous?.notes ?? { ...zeroNotes };
      const bpms = String(raw.bpm ?? '').match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
      output.set(key, {
        ...previous,
        id, title: previousSong?.title ?? canonical.title, difficulty, constant,
        genre: metadata.genre === 'Unknown' ? canonical.catname : metadata.genre,
        version: previousSong?.version && previousSong.version !== 'Unknown' ? previousSong.version : metadata.version === 'Unknown' ? 'MATE' : metadata.version,
        nickname: [...(previousSong?.nickname ?? [])],
        coverUrl: `https://otoge-db.net/chunithm/jacket/${encodeURIComponent(canonical.image)}`,
        bpm: bpms.length ? Math.max(...bpms) : previous?.bpm ?? null, notes,
      });
      detailOutput.delete(key);
    }
  }
  const charts = [...output.values()];
  const songIds = new Set(charts.map(chart => chart.id));
  return { charts, details: [...detailOutput.values()].filter(row => songIds.has(row.id) && !output.has(`${row.id}:${row.difficulty}`)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , upstreamPath, officialPath, cutoff = '2026-10-08'] = process.argv;
  if (!upstreamPath || !officialPath || !/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) throw new Error('用法：node scripts/refresh-catalog.mjs <music-ex.json> <official-music.json> [YYYY-MM-DD]');
  const load = async path => JSON.parse(await readFile(path, 'utf8'));
  const existing = await load('src/data/catalog.json');
  const result = refreshCatalog(existing, await load('src/data/song-chart-details.json'), await load(upstreamPath), await load(officialPath), cutoff);
  await writeFile('src/data/catalog.json', JSON.stringify(result.charts, null, 2) + '\n');
  await writeFile('src/data/song-chart-details.json', JSON.stringify(result.details, null, 2) + '\n');
  const modulePath = 'src/core/catalog.ts';
  await writeFile(modulePath, (await readFile(modulePath, 'utf8')).replace(/export (const|let) CATALOG_DATE = "[\d-]+";/, `export $1 CATALOG_DATE = "${cutoff}";`));
  console.log(JSON.stringify({ cutoff, addedCharts: result.charts.length - existing.length, charts: result.charts.length, songs: new Set(result.charts.map(chart => chart.id)).size }));
}
