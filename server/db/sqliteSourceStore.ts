import type { DatabaseSync } from 'node:sqlite';
import type { ExternalScoreSource } from '../../src/core/sources';
import { SYNC_SOURCES } from '../../src/syncTypes';
import { SourceStore, validateSavedSource, type SavedSource } from '../store';
import { localTransaction, withLocalDatabase } from './sqlite';

export class SqliteSourceStore extends SourceStore {
  constructor(private readonly db: DatabaseSync, dataDirectory: string) {
    super(dataDirectory);
  }

  override async initialize(): Promise<void> {
    await super.initialize();
    const migrationsDone = () => this.db.prepare('SELECT sources_migrated FROM workspace WHERE id = 1').get()?.sources_migrated === 1;
    if (withLocalDatabase(migrationsDone)) return;
    // Reuse the original profile directory so persistent browser sessions remain available.
    const legacy = new SourceStore(this.directory);
    const states = await Promise.all(SYNC_SOURCES.map(async source => ({ source, state: await legacy.load(source) })));
    localTransaction(this.db, () => {
      if (migrationsDone()) return;
      const insert = this.db.prepare('INSERT INTO source_states (source, state) VALUES (?, ?) ON CONFLICT(source) DO NOTHING');
      for (const { source, state } of states) insert.run(source, JSON.stringify(state));
      this.db.exec('UPDATE workspace SET sources_migrated = 1 WHERE id = 1');
    });
  }

  override async load(source: ExternalScoreSource): Promise<SavedSource> {
    return withLocalDatabase(() => {
      const row = this.db.prepare('SELECT state FROM source_states WHERE source = ?').get(source);
      if (!row) return { binding: null, lastAttemptAt: null, lastSuccessAt: null };
      return validateSavedSource(source, JSON.parse(row.state as string));
    });
  }

  override async save(source: ExternalScoreSource, state: SavedSource): Promise<void> {
    validateSavedSource(source, state);
    withLocalDatabase(() => this.db.prepare(`
      INSERT INTO source_states (source, state) VALUES (?, ?)
      ON CONFLICT(source) DO UPDATE SET state = excluded.state
    `).run(source, JSON.stringify(state)));
  }
}
