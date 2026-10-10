import { and, eq } from 'drizzle-orm';
import type { Database } from './db/connection';
import { withDatabase } from './db/connection';
import { personalAliases, scores, workspaces } from './db/schema';
import { catalogByKey } from '../src/core/catalog';
import { calculateRating } from '../src/core/rating';
import { chartKey } from '../src/core/b30';
import { enterManualScore, EMPTY_STATE, parseLocalState } from '../src/core/storage';
import { importSourceFile, type ExternalScoreSource, type SourceImportReport, type SourceMergeOptions } from '../src/core/sources';
import { importBackup } from '../src/core/backup';
import { mergeSyncResult } from '../src/core/sync';
import { SYNC_SOURCES, type SyncResult } from '../src/syncTypes';
import type { LocalState } from '../src/types';
import type { WorkspaceSnapshot, WorkspaceResult } from '../src/accountTypes';
import { SyncError } from './provider';

type DataAccess = Pick<Database, 'select' | 'insert' | 'update' | 'delete'>;
function invalid(message = '工作区请求格式无效。'): never { throw new SyncError('INVALID_REQUEST', message, 400); }
export function mergeOptions(value: unknown, source: string): SourceMergeOptions {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const option = value as Record<string, unknown>;
  if (Object.keys(option).some(key => key !== 'overwriteMunet') || (option.overwriteMunet !== undefined && (typeof option.overwriteMunet !== 'boolean' || source !== 'lxns'))) invalid();
  return { overwriteMunet: option.overwriteMunet as boolean | undefined };
}
export class WorkspaceRepository {
  constructor(private readonly db: Database) {}
  private async lock(tx: DataAccess, username: string) {
    await tx.insert(workspaces).values({ username }).onDuplicateKeyUpdate({ set: { username } });
    const [row] = await tx.select().from(workspaces).where(eq(workspaces.username, username)).for('update');
    return row;
  }
  private async read(tx: DataAccess, username: string): Promise<LocalState> {
    const state = structuredClone(EMPTY_STATE);
    const rows = await tx.select().from(scores).where(eq(scores.username, username));
    for (const row of rows) {
      const chart = catalogByKey.get(`${row.songId}:${row.difficulty}`);
      if (!chart) continue;
      state.scores[chartKey(chart)] = {
        id: chart.id, title: chart.title, difficulty: chart.difficulty, constant: chart.constant,
        score: row.score, rating: calculateRating(row.score, chart.constant), source: row.source, updatedAt: row.updatedAt,
        ...(row.combo ? { combo: row.combo } : {}), ...(row.fullChain ? { fullChain: row.fullChain } : {}),
      };
    }
    for (const row of await tx.select().from(personalAliases).where(eq(personalAliases.username, username))) state.nicknameOverrides[row.songId] = row.aliases;
    return state;
  }
  private async write(tx: DataAccess, username: string, before: LocalState, after: LocalState): Promise<void> {
    for (const [key, previous] of Object.entries(before.scores)) {
      if (!after.scores[key]) await tx.delete(scores).where(and(eq(scores.username, username), eq(scores.songId, previous.id), eq(scores.difficulty, previous.difficulty)));
    }
    for (const [key, record] of Object.entries(after.scores)) {
      if (JSON.stringify(record) === JSON.stringify(before.scores[key])) continue;
      const row = { username, songId: record.id, difficulty: record.difficulty, score: record.score, source: record.source, combo: record.combo ?? null, fullChain: record.fullChain ?? null, updatedAt: record.updatedAt };
      await tx.insert(scores).values(row).onDuplicateKeyUpdate({ set: row });
    }
    for (const id of Object.keys(before.nicknameOverrides)) {
      if (!after.nicknameOverrides[id]) await tx.delete(personalAliases).where(and(eq(personalAliases.username, username), eq(personalAliases.songId, id)));
    }
    for (const [songId, aliases] of Object.entries(after.nicknameOverrides)) {
      if (JSON.stringify(aliases) === JSON.stringify(before.nicknameOverrides[songId])) continue;
      const row = { username, songId, aliases };
      await tx.insert(personalAliases).values(row).onDuplicateKeyUpdate({ set: row });
    }
  }
  async get(username: string): Promise<WorkspaceSnapshot> {
    return withDatabase(() => this.db.transaction(async tx => {
      const row = await this.lock(tx, username);
      return { state: await this.read(tx, username), revision: row.revision, legacyMigrated: row.legacyMigrated };
    }));
  }
  private async change(username: string, apply: (state: LocalState) => { state: LocalState; notice?: string; report?: SourceImportReport }, migrate = false, replace = false): Promise<WorkspaceResult> {
    return withDatabase(() => this.db.transaction(async tx => {
      const row = await this.lock(tx, username);
      const before = await this.read(tx, username);
      if (migrate && row.legacyMigrated) return { state: before, revision: row.revision, legacyMigrated: true, notice: '旧浏览器数据已经迁移，未重复导入。' };
      let result: ReturnType<typeof apply>;
      try { result = apply(structuredClone(before)); } catch (error) {
        if (error instanceof SyncError) throw error;
        invalid(error instanceof Error ? error.message : undefined);
      }
      if (replace) {
        await tx.delete(scores).where(eq(scores.username, username));
        await tx.delete(personalAliases).where(eq(personalAliases.username, username));
      }
      await this.write(tx, username, replace ? structuredClone(EMPTY_STATE) : before, result.state);
      const revision = row.revision + 1;
      await tx.update(workspaces).set({ revision, ...(migrate ? { legacyMigrated: true } : {}) }).where(eq(workspaces.username, username));
      return { ...result, revision, legacyMigrated: migrate || row.legacyMigrated };
    }));
  }
  async action(username: string, input: Record<string, unknown>): Promise<WorkspaceResult> {
    return this.change(username, state => {
      switch (input.type) {
        case 'manual': {
          if (typeof input.key !== 'string' || typeof input.score !== 'string') invalid();
          const chart = catalogByKey.get(input.key);
          if (!chart) invalid('谱面不在当前曲库中。');
          return { state: enterManualScore(state, chart, input.score), notice: '分数已保存，来源标记为神秘游客。' };
        }
        case 'delete': {
          if (typeof input.key !== 'string') invalid();
          delete state.scores[input.key];
          return { state, notice: '成绩已删除。' };
        }
        case 'clear': return { state: structuredClone(EMPTY_STATE), notice: '当前账号的成绩和个人别名已清空。' };
        case 'aliases': {
          if (typeof input.id !== 'string' || ![...catalogByKey.values()].some(chart => chart.id === input.id) || !Array.isArray(input.aliases) || input.aliases.length > 128 || input.aliases.some(alias => typeof alias !== 'string' || alias.length > 128)) invalid();
          const seen = new Set<string>();
          const aliases = (input.aliases as string[]).map(alias => alias.normalize('NFKC').trim()).filter(alias => {
            const key = alias.toLocaleLowerCase('zh-CN');
            if (!alias || seen.has(key)) return false;
            seen.add(key); return true;
          });
          if (aliases.length) state.nicknameOverrides[input.id] = aliases; else delete state.nicknameOverrides[input.id];
          return { state, notice: '个人别名已保存。' };
        }
        case 'import': {
          if (!SYNC_SOURCES.includes(input.source as ExternalScoreSource) || typeof input.raw !== 'string' || Buffer.byteLength(input.raw) > 10 * 1024 * 1024 || typeof input.filename !== 'string' || input.filename.length > 512) invalid();
          const result = importSourceFile(input.raw, input.source as ExternalScoreSource, state, catalogByKey, input.filename, mergeOptions(input.mergeOptions, input.source as string));
          return { state: result.state, report: result.report, notice: `导入完成：新增 ${result.report.importedScores}，更新 ${result.report.updatedScores}，跳过 ${result.report.skippedScores + result.report.invalidEntries + result.report.unknownCharts}。` };
        }
        case 'backup': {
          if (typeof input.raw !== 'string' || Buffer.byteLength(input.raw) > 10 * 1024 * 1024 || !['merge', 'replace'].includes(input.mode as string)) invalid();
          const result = importBackup(input.raw, state, catalogByKey, input.mode as 'merge' | 'replace');
          return { state: result.state, notice: `备份导入完成：成绩 ${result.report.importedScores}，别名 ${result.report.importedAliases}，跳过 ${result.report.skippedScores}。` };
        }
        default: invalid();
      }
    }, false, input.type === 'clear' || (input.type === 'backup' && input.mode === 'replace'));
  }
  async migrate(username: string, input: Record<string, unknown>): Promise<WorkspaceResult> {
    if (username !== 'root') throw new SyncError('FORBIDDEN', '旧全局浏览器数据只能归入 root。', 403);
    let legacy: LocalState;
    try { legacy = parseLocalState(JSON.stringify(input.state)); } catch { invalid('旧浏览器数据无效，原数据未删除。'); }
    return this.change(username, state => {
      const backup = { ...legacy, scores: Object.values(legacy.scores) };
      const result = importBackup(JSON.stringify(backup), state, catalogByKey, 'merge');
      return { state: result.state, notice: `旧数据迁移完成：成绩 ${result.report.importedScores}，个人别名 ${result.report.importedAliases}，跳过 ${result.report.skippedScores}；浏览器原副本保留。` };
    }, true);
  }
  async mergeSync(username: string, result: SyncResult, options: SourceMergeOptions): Promise<WorkspaceResult> {
    return this.change(username, state => mergeSyncResult(state, result, options));
  }
}
