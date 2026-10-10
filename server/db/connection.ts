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
export async function withDatabase<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) { if (error instanceof SyncError) throw error; throw databaseFailure(); }
}
