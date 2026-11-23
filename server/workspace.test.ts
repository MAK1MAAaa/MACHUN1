import { describe, expect, it, vi } from 'vitest';
import { WorkspaceRepository } from './workspace';
import type { DatabaseSync } from 'node:sqlite';

describe('workspace import options', () => {
  it.each([
    { mergeOptions: { overwriteMunet: true } },
    { mergeOptions: { overwriteMunet: false } },
    { mergeOptions: {} },
    { overwriteMunet: true },
  ])('rejects removed override options before opening a transaction: %j', async extra => {
    const exec = vi.fn();
    const repository = new WorkspaceRepository({ exec } as unknown as DatabaseSync);

    await expect(repository.action({
      type: 'import', source: 'lxns', raw: '[]', filename: 'scores.json', ...extra,
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
    expect(exec).not.toHaveBeenCalled();
  });
});
