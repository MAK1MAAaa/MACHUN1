import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { catalog, CATALOG_DATE, CATALOG_VERSION } from '../../src/core/catalog';
import detailData from '../../src/data/song-chart-details.json';
import type { CatalogSnapshot } from '../../src/accountTypes';
import type { SongChartDetail } from '../../src/core/songDetails';
import { SyncError } from '../provider';

const SCHEMA_VERSION = 1;

export function withLocalDatabase<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof SyncError) throw error;
    throw new SyncError('DATABASE_UNAVAILABLE', '本地 SQLite 无法访问，请检查数据目录权限或其他运行中的实例。', 503);
  }
}

export function localTransaction<T>(db: DatabaseSync, operation: () => T): T {
  return withLocalDatabase(() => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  });
}

export function openLocalDatabase(dataDirectory: string) {
  return withLocalDatabase(() => {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const path = join(dataDirectory, 'machun1.sqlite');
    closeSync(openSync(path, 'a', 0o600));
    chmodSync(path, 0o600);
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      localTransaction(db, () => {
        const version = db.prepare('PRAGMA user_version').get()?.user_version;
        if (version === SCHEMA_VERSION) return;
        if (version !== 0) {
          throw new SyncError('DATABASE_SCHEMA_OUTDATED', '本地 SQLite 由较新版 MACHUN1 创建，请使用匹配的应用版本。', 503);
        }
        db.exec(`
          CREATE TABLE workspace (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            revision INTEGER NOT NULL DEFAULT 0,
            legacy_migrated INTEGER NOT NULL DEFAULT 0,
            sources_migrated INTEGER NOT NULL DEFAULT 0,
            export_nickname TEXT NOT NULL DEFAULT ''
          ) STRICT;
          INSERT INTO workspace (id) VALUES (1);
          CREATE TABLE scores (
            song_id TEXT NOT NULL,
            difficulty TEXT NOT NULL CHECK (difficulty IN ('EXP', 'MAS', 'ULT')),
            score INTEGER NOT NULL,
            source TEXT NOT NULL,
            combo TEXT,
            full_chain TEXT,
            clear_status TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (song_id, difficulty)
          ) STRICT;
          CREATE TABLE personal_aliases (
            song_id TEXT PRIMARY KEY,
            aliases TEXT NOT NULL CHECK (json_valid(aliases))
          ) STRICT;
          CREATE TABLE source_states (
            source TEXT PRIMARY KEY CHECK (source IN ('rin', 'munet', 'otogame', 'lxns')),
            state TEXT NOT NULL CHECK (json_valid(state))
          ) STRICT;
          PRAGMA user_version = ${SCHEMA_VERSION};
        `);
      });
    } catch (error) {
      db.close();
      throw error;
    }
    return { db, path, close: () => db.close() };
  });
}

export function loadLocalCatalog(): CatalogSnapshot {
  return { date: CATALOG_DATE, version: CATALOG_VERSION, charts: catalog, details: detailData as SongChartDetail[] };
}
