import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { createPool } from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import * as schema from './schema';
import { SyncError } from '../provider';

export async function databaseUrl(projectRoot: string): Promise<string> {
  let values: Record<string, string | undefined> = {};
  try { values = parseEnv(await readFile(resolve(projectRoot, '.env'), 'utf8')); } catch { /* environment may supply the URL */ }
  const url = process.env.DATABASE_URL ?? values.DATABASE_URL;
  if (!url) throw new SyncError('DATABASE_UNAVAILABLE', '未配置 MySQL，请先运行 pnpm db:setup 和 pnpm db:tunnel。', 503);
  return url;
}
export function createDatabase(url: string) {
  const pool = createPool({ uri: url, connectionLimit: 5, timezone: 'Z', connectTimeout: 5000, enableKeepAlive: true });
  return { pool, db: drizzle(pool, { schema, mode: 'default' }) };
}
export type Database = ReturnType<typeof createDatabase>['db'];
export function databaseFailure(): SyncError {
  return new SyncError('DATABASE_UNAVAILABLE', 'MySQL 暂不可用，请检查 SSH 隧道和数据库连接后重试；本次未保存。', 503);
}
function requiredMigration(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const wrapper = error as { cause?: unknown };
  const driver = wrapper.cause && typeof wrapper.cause === 'object' ? wrapper.cause : error;
  const detail = driver as { code?: unknown; sqlMessage?: unknown };
  if (detail.code !== 'ER_BAD_FIELD_ERROR' || typeof detail.sqlMessage !== 'string') return null;
  if (detail.sqlMessage.includes('clear_status')) return '0003_score_clear_status.sql';
  if (detail.sqlMessage.includes('export_nickname')) return '0004_export_nickname.sql';
  return null;
}
export async function withDatabase<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    if (error instanceof SyncError) throw error;
    const migration = requiredMigration(error);
    if (migration) throw new SyncError('DATABASE_SCHEMA_OUTDATED', `数据库结构需要更新，请由管理员执行 db/migrations/${migration} 后重试；本次未保存。`, 503);
    throw databaseFailure();
  }
}
