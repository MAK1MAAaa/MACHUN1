import { describe, expect, it } from 'vitest';
import { withDatabase } from './connection';
import { SyncError } from '../provider';

describe('database error boundaries', () => {
  it('identifies the missing clear column without exposing SQL or automatically migrating', async () => {
    const driver = { code: 'ER_BAD_FIELD_ERROR', sqlMessage: "Unknown column 'scores.clear_status' in 'field list'", sql: 'private query' };
    for (const error of [driver, { cause: driver }]) {
      await expect(withDatabase(async () => { throw error; })).rejects.toMatchObject({
        code: 'DATABASE_SCHEMA_OUTDATED', status: 503,
        message: '数据库结构需要更新，请由管理员执行 db/migrations/0003_score_clear_status.sql 后重试；本次未保存。',
      });
    }
  });

  it('keeps unrelated driver failures controlled and preserves deliberate API errors', async () => {
    await expect(withDatabase(async () => { throw { code: 'ER_BAD_FIELD_ERROR', sqlMessage: 'Unknown column other_private_field' }; }))
      .rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
    const error = new SyncError('INVALID_REQUEST', '输入无效', 400);
    await expect(withDatabase(async () => { throw error; })).rejects.toBe(error);
  });
});
