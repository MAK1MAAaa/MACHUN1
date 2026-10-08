import { asc, eq } from 'drizzle-orm';
import { catalog, CATALOG_DATE, CATALOG_VERSION, validateCatalog } from '../../src/core/catalog';
import detailData from '../../src/data/song-chart-details.json';
import provenance from '../../src/data/catalog-sources.json';
import type { CatalogSnapshot } from '../../src/accountTypes';
import type { SongChartDetail } from '../../src/core/songDetails';
import type { Database } from './connection';
import { withDatabase } from './connection';
import { catalogMeta, charts, songs } from './schema';
import { SyncError } from '../provider';

export async function seedCatalog(db: Database): Promise<void> {
  await withDatabase(() => db.transaction(async tx => {
    const songRows = new Map(catalog.map(chart => [chart.id, chart]));
    for (const chart of songRows.values()) {
      const row = { id: chart.id, title: chart.title, genre: chart.genre, version: chart.version, coverUrl: chart.coverUrl, aliases: chart.nickname };
      await tx.insert(songs).values(row).onDuplicateKeyUpdate({ set: row });
    }
    for (const [position, chart] of catalog.entries()) {
      const row = { songId: chart.id, difficulty: chart.difficulty, constant: chart.constant, bpm: chart.bpm, notes: chart.notes, scoring: true, position };
      await tx.insert(charts).values(row).onDuplicateKeyUpdate({ set: row });
    }
    for (const [position, chart] of (detailData as SongChartDetail[]).entries()) {
      const row = { songId: chart.id, difficulty: chart.difficulty, constant: chart.constant, bpm: null, notes: null, scoring: false, position: catalog.length + position };
      await tx.insert(charts).values(row).onDuplicateKeyUpdate({ set: row });
    }
    const row = { id: 1, date: CATALOG_DATE, version: CATALOG_VERSION, provenance };
    await tx.insert(catalogMeta).values(row).onDuplicateKeyUpdate({ set: row });
  }));
}
export async function loadCatalog(db: Database): Promise<CatalogSnapshot> {
  return withDatabase(() => db.transaction(async tx => {
    const [meta] = await tx.select().from(catalogMeta).where(eq(catalogMeta.id, 1));
    if (!meta) throw new SyncError('DATABASE_UNAVAILABLE', 'MySQL 曲库未初始化，请运行 pnpm db:catalog。', 503);
    const rows = await tx.select().from(charts).innerJoin(songs, eq(charts.songId, songs.id)).orderBy(asc(charts.position));
    const data = rows.filter(row => row.charts.scoring).map(({ charts: chart, songs: song }) => ({
      id: song.id, title: song.title, difficulty: chart.difficulty, constant: chart.constant,
      genre: song.genre, version: song.version, coverUrl: song.coverUrl, bpm: chart.bpm,
      nickname: song.aliases, notes: chart.notes,
    }));
    return { date: meta.date, version: meta.version, charts: validateCatalog(data), details: rows.filter(row => !row.charts.scoring).map(({ charts: chart }) => ({ id: chart.songId, difficulty: chart.difficulty, constant: chart.constant })) };
  }));
}
