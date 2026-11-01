import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// date_updated includes metadata edits and is deliberately never a release date.
export const CHART_RELEASE_OVERRIDES = [
  { id: '2317', title: 'きゅうくらりん', difficulty: 'ULT', date: '2026-09-25', source: 'https://info-chunithm.sega.jp/12719/' },
  { id: '2175', title: 'シル・ヴ・プレジデント', difficulty: 'ULT', date: '2026-10-22', source: 'https://info-chunithm.sega.jp/12772/' },
];
const overrides = new Map(CHART_RELEASE_OVERRIDES.map(row => [`${row.id}:${row.difficulty}`, row]));
const prefixes = { EXP: 'lev_exp', MAS: 'lev_mas', ULT: 'lev_ult' };
const titleText = value => typeof value === 'string' ? value.normalize('NFKC').trim() : '';

export function normalizeReleaseDate(value) {
  const compact = String(value ?? '').replaceAll('-', '');
  if (!/^\d{8}$/.test(compact)) return null;
  const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6)}`;
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : null;
}

export function buildChartReleaseDates(charts, upstream, previous = {}, cutoff = '2026-11-01') {
  const cutoffDate = normalizeReleaseDate(cutoff);
  if (!Array.isArray(charts) || !Array.isArray(upstream) || !cutoffDate || !previous || typeof previous !== 'object' || Array.isArray(previous)) throw new Error('上线日期输入或截止日期无效。');
  const songs = new Map(upstream.filter(song => song?.title && !song.we_kanji).map(song => [String(song.id), song]));
  const dates = {};
  const stats = { charts: charts.length, dated: 0, chartDates: 0, songDates: 0, preservedDates: 0, unknownDates: 0 };
  for (const chart of charts) {
    if (typeof chart?.id !== 'string' || !prefixes[chart.difficulty]) throw new Error('上线日期谱面格式无效。');
    const key = `${chart.id}:${chart.difficulty}`;
    if (Object.hasOwn(dates, key)) throw new Error(`上线日期谱面重复：${key}`);
    const song = songs.get(chart.id);
    const override = overrides.get(key);
    if ((song && titleText(song.title) !== titleText(chart.title)) || (override && titleText(override.title) !== titleText(chart.title))) throw new Error(`上线日期编号与曲名不匹配：${key}`);
    const candidates = [
      [normalizeReleaseDate(override?.date), 'chartDates'],
      [normalizeReleaseDate(song?.[`${prefixes[chart.difficulty]}_date_added`]), 'chartDates'],
      [normalizeReleaseDate(song?.date_added), 'songDates'],
      [normalizeReleaseDate(previous[key]), 'preservedDates'],
    ];
    const [date, basis] = candidates.find(([date]) => date !== null) ?? [null, null];
    dates[key] = date && date <= cutoffDate ? date : null;
    if (dates[key]) { stats.dated++; stats[basis]++; } else stats.unknownDates++;
  }
  return { dates, stats };
}

export function releaseDateProvenance(stats, upstreamSha256) {
  return {
    ...stats,
    upstreamSha256,
    policy: '明确的谱面上线日期优先；未提供时按歌曲首次上线日期排序。上游 date_updated 仅表示元数据更新，不作为上线日期。缺失来源时保留有效旧日期，其余未知以 null 保留。',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , upstreamPath, cutoff = '2026-11-01'] = process.argv;
  if (!upstreamPath) throw new Error('用法：node scripts/build-chart-release-dates.mjs <music-ex.json> [YYYY-MM-DD]');
  const upstreamInput = await readFile(upstreamPath);
  const charts = JSON.parse(await readFile('src/data/catalog.json', 'utf8'));
  let previous = {};
  try { previous = JSON.parse(await readFile('src/data/chart-release-dates.json', 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { dates, stats } = buildChartReleaseDates(charts, JSON.parse(upstreamInput.toString('utf8')), previous, cutoff);
  const provenance = JSON.parse(await readFile('src/data/catalog-sources.json', 'utf8'));
  provenance.chartReleaseDates = { ...provenance.chartReleaseDates, ...Object.fromEntries(CHART_RELEASE_OVERRIDES.map(({ id, difficulty, date, source }) => [`${id}:${difficulty}`, { date, source }])) };
  provenance.releaseDateMetadata = releaseDateProvenance(stats, createHash('sha256').update(upstreamInput).digest('hex'));
  await writeFile('src/data/chart-release-dates.json', JSON.stringify(dates, null, 2) + '\n');
  await writeFile('src/data/catalog-sources.json', JSON.stringify(provenance, null, 2) + '\n');
  console.log(JSON.stringify(stats));
}
