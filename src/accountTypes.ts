import type { LocalState, CatalogChart } from './types';
import type { SourceImportReport, SourceMergeOptions } from './core/sources';
import type { SyncResult } from './syncTypes';
import type { SongChartDetail } from './core/songDetails';

export interface Account { username: string }
export interface CatalogSnapshot { date: string; version: string; charts: CatalogChart[]; details: SongChartDetail[] }
export interface WorkspaceSnapshot { state: LocalState; revision: number; legacyMigrated: boolean }
export type WorkspaceAction =
  | { type: 'manual'; key: string; score: string }
  | { type: 'delete'; key: string }
  | { type: 'clear' }
  | { type: 'aliases'; id: string; aliases: string[] }
  | { type: 'import'; source: string; raw: string; filename: string; mergeOptions?: SourceMergeOptions }
  | { type: 'backup'; raw: string; mode: 'merge' | 'replace' };
export interface WorkspaceResult extends WorkspaceSnapshot { notice?: string; report?: SourceImportReport }
export type AccountSyncResult = SyncResult & { workspace: WorkspaceSnapshot };
