import type { DatabaseSync } from 'node:sqlite';
import { localTransaction } from './db/sqlite';
import { catalogByKey } from '../src/core/catalog';
import { calculateRating } from '../src/core/rating';
import { chartKey } from '../src/core/b30';
import { enterManualScore, EMPTY_STATE, parseLocalState } from '../src/core/storage';
import { importSourceFile, type ExternalScoreSource, type SourceImportReport } from '../src/core/sources';
import { importBackup } from '../src/core/backup';
import { mergeSyncResult } from '../src/core/sync';
import { SYNC_SOURCES, type SyncResult } from '../src/syncTypes';
import type { LocalState, SingleRating } from '../src/types';
import type { WorkspaceSnapshot, WorkspaceResult } from '../src/accountTypes';
import { SyncError } from './provider';

type WorkspaceMutation = { state: LocalState; notice?: string; report?: SourceImportReport; exportNickname?: string };
type ScoreRow = {
  song_id: SingleRating['id'];
  difficulty: SingleRating['difficulty'];
  score: SingleRating['score'];
  source: SingleRating['source'];
  combo: SingleRating['combo'] | null;
  full_chain: SingleRating['fullChain'] | null;
  clear_status: SingleRating['clear'] | null;
  updated_at: SingleRating['updatedAt'];
};
type WorkspaceRow = { revision: number; legacy_migrated: number; export_nickname: string };

function invalid(message = '工作区请求格式无效。'): never { throw new SyncError('INVALID_REQUEST', message, 400); }

export class WorkspaceRepository {
  constructor(private readonly db: DatabaseSync) {}

  private metadata(): WorkspaceRow {
    return this.db.prepare('SELECT revision, legacy_migrated, export_nickname FROM workspace WHERE id = 1').get() as WorkspaceRow;
  }

  private read(): LocalState {
    const state = structuredClone(EMPTY_STATE);
    const scores = this.db.prepare('SELECT song_id, difficulty, score, source, combo, full_chain, clear_status, updated_at FROM scores').all() as ScoreRow[];
    for (const row of scores) {
      const chart = catalogByKey.get(`${row.song_id}:${row.difficulty}`);
      if (!chart) continue;
      state.scores[chartKey(chart)] = {
        id: chart.id, title: chart.title, difficulty: chart.difficulty, constant: chart.constant,
        score: row.score, rating: calculateRating(row.score, chart.constant), source: row.source, updatedAt: row.updated_at,
        ...(row.combo ? { combo: row.combo } : {}), ...(row.full_chain ? { fullChain: row.full_chain } : {}), ...(row.clear_status ? { clear: row.clear_status } : {}),
      };
    }
    const aliases = this.db.prepare('SELECT song_id, aliases FROM personal_aliases').all() as { song_id: string; aliases: string }[];
    for (const row of aliases) state.nicknameOverrides[row.song_id] = JSON.parse(row.aliases);
    return state;
  }

  private write(before: LocalState, after: LocalState): void {
    const deleteScore = this.db.prepare('DELETE FROM scores WHERE song_id = ? AND difficulty = ?');
    for (const [key, previous] of Object.entries(before.scores)) {
      if (!after.scores[key]) deleteScore.run(previous.id, previous.difficulty);
    }
    const saveScore = this.db.prepare(`
      INSERT INTO scores (song_id, difficulty, score, source, combo, full_chain, clear_status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(song_id, difficulty) DO UPDATE SET
        score = excluded.score, source = excluded.source, combo = excluded.combo,
        full_chain = excluded.full_chain, clear_status = excluded.clear_status, updated_at = excluded.updated_at
    `);
    for (const [key, record] of Object.entries(after.scores)) {
      if (JSON.stringify(record) === JSON.stringify(before.scores[key])) continue;
      saveScore.run(record.id, record.difficulty, record.score, record.source, record.combo ?? null, record.fullChain ?? null, record.clear ?? null, record.updatedAt);
    }
    const deleteAliases = this.db.prepare('DELETE FROM personal_aliases WHERE song_id = ?');
    for (const id of Object.keys(before.nicknameOverrides)) {
      if (!after.nicknameOverrides[id]) deleteAliases.run(id);
    }
    const saveAliases = this.db.prepare(`
      INSERT INTO personal_aliases (song_id, aliases) VALUES (?, ?)
      ON CONFLICT(song_id) DO UPDATE SET aliases = excluded.aliases
    `);
    for (const [songId, aliases] of Object.entries(after.nicknameOverrides)) {
      if (JSON.stringify(aliases) === JSON.stringify(before.nicknameOverrides[songId])) continue;
      saveAliases.run(songId, JSON.stringify(aliases));
    }
  }

  async get(): Promise<WorkspaceSnapshot> {
    return localTransaction(this.db, () => {
      const row = this.metadata();
      return { state: this.read(), revision: row.revision, legacyMigrated: Boolean(row.legacy_migrated), exportNickname: row.export_nickname };
    });
  }

  private async change(apply: (state: LocalState) => WorkspaceMutation, migrate = false, replace = false): Promise<WorkspaceResult> {
    return localTransaction(this.db, () => {
      const row = this.metadata();
      const before = this.read();
      if (migrate && row.legacy_migrated) return { state: before, revision: row.revision, legacyMigrated: true, exportNickname: row.export_nickname, notice: '旧浏览器数据已经迁移，未重复导入。' };
      let result: ReturnType<typeof apply>;
      try { result = apply(structuredClone(before)); } catch (error) {
        if (error instanceof SyncError) throw error;
        invalid(error instanceof Error ? error.message : undefined);
      }
      if (replace) this.db.exec('DELETE FROM scores; DELETE FROM personal_aliases;');
      this.write(replace ? EMPTY_STATE : before, result.state);
      const revision = row.revision + 1;
      const exportNickname = result.exportNickname ?? row.export_nickname;
      const legacyMigrated = migrate || Boolean(row.legacy_migrated);
      this.db.prepare('UPDATE workspace SET revision = ?, export_nickname = ?, legacy_migrated = ? WHERE id = 1')
        .run(revision, exportNickname, Number(legacyMigrated));
      return { ...result, revision, legacyMigrated, exportNickname };
    });
  }

  async action(input: Record<string, unknown>): Promise<WorkspaceResult> {
    if (input.type === 'import' && Object.keys(input).some(key => !['type', 'source', 'raw', 'filename'].includes(key))) invalid();
    return this.change(state => {
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
        case 'clear': return { state: structuredClone(EMPTY_STATE), notice: '本地成绩和个人别名已清空。' };
        case 'export-nickname': {
          if (typeof input.nickname !== 'string') invalid('导出昵称格式无效。');
          const nickname = input.nickname.trim();
          if (Array.from(nickname).length > 32 || /[\u0000-\u001f\u007f]/u.test(nickname)) invalid('导出昵称最多 32 个字符，且不能包含换行或控制字符。');
          return { state, exportNickname: nickname, notice: '导出昵称已保存。' };
        }
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
          const result = importSourceFile(input.raw, input.source as ExternalScoreSource, state, catalogByKey, input.filename);
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
  async migrate(input: Record<string, unknown>): Promise<WorkspaceResult> {
    let legacy: LocalState;
    try { legacy = parseLocalState(JSON.stringify(input.state)); } catch { invalid('旧浏览器数据无效，原数据未删除。'); }
    return this.change(state => {
      const backup = { ...legacy, scores: Object.values(legacy.scores) };
      const result = importBackup(JSON.stringify(backup), state, catalogByKey, 'merge');
      return { state: result.state, notice: `旧数据迁移完成：成绩 ${result.report.importedScores}，个人别名 ${result.report.importedAliases}，跳过 ${result.report.skippedScores}；浏览器原副本保留。` };
    }, true);
  }
  async mergeSync(result: SyncResult): Promise<WorkspaceResult> {
    return this.change(state => mergeSyncResult(state, result));
  }
}
