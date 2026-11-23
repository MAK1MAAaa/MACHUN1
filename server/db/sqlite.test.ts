import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chartKey } from '../../src/core/b30';
import { catalog } from '../../src/core/catalog';
import { calculateRating } from '../../src/core/rating';
import { createFullBackup } from '../../src/core/backup';
import { SourceStore, type SavedSource } from '../store';
import { WorkspaceRepository } from '../workspace';
import { openLocalDatabase } from './sqlite';
import { SqliteSourceStore } from './sqliteSourceStore';

const directories: string[] = [];
const connections: ReturnType<typeof openLocalDatabase>[] = [];

afterEach(async () => {
  for (const connection of connections.splice(0)) if (connection.db.isOpen) connection.close();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function open(directory: string) {
  const connection = openLocalDatabase(directory);
  connections.push(connection);
  return connection;
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'machun-sqlite-'));
  directories.push(directory);
  return { directory, ...open(directory) };
}

describe('local SQLite workspace', () => {
  const [chart] = catalog;
  const key = chartKey(chart);

  it('persists revisions, scores, aliases and export nickname after closing and reopening', async () => {
    const { directory, db, close, path } = await setup();
    const workspace = new WorkspaceRepository(db);
    await expect(workspace.get()).resolves.toMatchObject({ revision: 0, exportNickname: '' });
    await workspace.action({ type: 'manual', key, score: '1005000' });
    await workspace.action({ type: 'aliases', id: chart.id, aliases: ['  ｐｃ  ', 'PC'] });
    await workspace.action({ type: 'export-nickname', nickname: '  Local Player  ' });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    close();

    const restored = await new WorkspaceRepository(open(directory).db).get();
    expect(restored).toMatchObject({
      revision: 3,
      exportNickname: 'Local Player',
      state: {
        scores: { [key]: { score: 1005000, source: 'manual', rating: calculateRating(1005000, chart.constant) } },
        nicknameOverrides: { [chart.id]: ['pc'] },
      },
    });
  });

  it('rolls back destructive replacements and retains all achievement fields', async () => {
    const { db } = await setup();
    const workspace = new WorkspaceRepository(db);
    const raw = JSON.stringify({
      schemaVersion: 2,
      scores: [{ id: chart.id, difficulty: chart.difficulty, score: 1005000, source: 'rin', combo: 'aj', fullChain: 'gold', clear: 'hard' }],
      nicknameOverrides: { [chart.id]: ['saved alias'] },
    });
    await workspace.action({ type: 'backup', raw, mode: 'replace' });
    const before = await workspace.get();
    expect(before.state.scores[key]).toMatchObject({ combo: 'aj', fullChain: 'gold', clear: 'hard' });

    db.exec(`CREATE TEMP TRIGGER reject_revision BEFORE UPDATE ON workspace
      BEGIN SELECT RAISE(ABORT, 'forced failure after data deletion'); END;`);
    await expect(workspace.action({ type: 'clear' })).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
    expect(await workspace.get()).toEqual(before);
    db.exec('DROP TRIGGER reject_revision');

    const replacement = createFullBackup({ schemaVersion: 2, scores: {}, nicknameOverrides: {} }, 'test');
    await workspace.action({ type: 'backup', raw: JSON.stringify(replacement), mode: 'replace' });
    await expect(workspace.get()).resolves.toMatchObject({ state: { scores: {}, nicknameOverrides: {} }, revision: 2 });
  });

  it('imports browser records once without discarding current local changes', async () => {
    const { db } = await setup();
    const workspace = new WorkspaceRepository(db);
    await workspace.action({ type: 'manual', key, score: '1005000' });
    const current = await workspace.get();
    const legacy = structuredClone(current.state);
    legacy.scores[key].score = 1001000;
    const migrated = await workspace.migrate({ state: legacy });
    expect(migrated).toMatchObject({ revision: 2, legacyMigrated: true, state: { scores: { [key]: { score: 1005000 } } } });
    await workspace.action({ type: 'delete', key });
    const repeated = await workspace.migrate({ state: legacy });
    expect(repeated.revision).toBe(3);
    expect(repeated.state.scores).toEqual({});
  });

  it('merges sync results into the latest scores across database connections', async () => {
    const { directory, db } = await setup();
    const workspace = new WorkspaceRepository(db);
    const second = new WorkspaceRepository(open(directory).db);
    const otherChart = catalog[1];
    const otherKey = chartKey(otherChart);
    const timestamp = '2026-10-04T12:00:00.000Z';
    await workspace.action({ type: 'manual', key, score: '1005000' });
    const merged = await second.mergeSync({
      source: 'rin',
      records: [chart, otherChart].map(item => ({
        id: item.id, title: item.title, difficulty: item.difficulty, constant: item.constant,
        score: 1003000, rating: calculateRating(1003000, item.constant), source: 'rin', updatedAt: timestamp,
      })),
      report: { parsedScores: 2, importedScores: 2, updatedScores: 0, skippedScores: 0, unknownCharts: 0, invalidEntries: 0 },
      connection: { source: 'rin', status: 'ready', bound: true, identity: null, lastAttemptAt: timestamp, lastSuccessAt: timestamp, error: null },
    });

    expect(merged).toMatchObject({ revision: 2, report: { importedScores: 1, skippedScores: 1 } });
    expect((await workspace.get()).state.scores).toMatchObject({
      [key]: { score: 1005000, source: 'manual' },
      [otherKey]: { score: 1003000, source: 'rin' },
    });
  });
});

describe('local SQLite source state', () => {
  it('moves legacy binding state into SQLite once while continuing to use the existing profile', async () => {
    const { directory, db, close } = await setup();
    const legacy = new SourceStore(directory);
    await legacy.initialize();
    const profile = await legacy.newProfile('otogame');
    const sessionFile = join(legacy.profilePath(profile), 'existing-session');
    await writeFile(sessionFile, 'session files remain in place');
    const identity = { id: 'synthetic-account', label: '测试账号', cardId: 'synthetic-card' };
    const state: SavedSource = {
      binding: { identity, profile },
      lastAttemptAt: '2026-10-04T12:00:00.000Z',
      lastSuccessAt: '2026-10-04T12:01:00.000Z',
      otogameCache: {
        identity,
        records: [],
        checkpoint: { timestamp: 1791111111000, boundaryKeys: ['ab'.repeat(32)] },
      },
    };
    await legacy.save('otogame', state);

    const store = new SqliteSourceStore(db, directory);
    await store.initialize();
    expect(store.profilePath(profile)).toBe(legacy.profilePath(profile));
    expect(await readFile(join(store.profilePath(profile), 'existing-session'), 'utf8')).toBe('session files remain in place');
    expect(await store.load('otogame')).toEqual(state);

    const unbound = { binding: null, lastAttemptAt: null, lastSuccessAt: null };
    await store.save('otogame', unbound);
    close();

    const restored = new SqliteSourceStore(open(directory).db, directory);
    await restored.initialize();
    expect(await restored.load('otogame')).toEqual(unbound);
    expect(await legacy.load('otogame')).toEqual(state);
  });

  it('keeps source migration retryable when an older binding file cannot be read', async () => {
    const { directory, db } = await setup();
    const store = new SqliteSourceStore(db, directory);
    await writeFile(join(directory, 'rin.json'), 'invalid data');
    await expect(store.initialize()).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM source_states').get()?.count).toBe(0);

    await rm(join(directory, 'rin.json'));
    await store.initialize();
    expect(await store.load('rin')).toMatchObject({ binding: null });
  });
});
