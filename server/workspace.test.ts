import { describe, expect, it, vi } from 'vitest';
import { WorkspaceRepository } from './workspace';
import type { Database } from './db/connection';

describe('workspace import options', () => {
  it.each([
    { mergeOptions: { overwriteMunet: true } },
    { mergeOptions: { overwriteMunet: false } },
    { mergeOptions: {} },
    { overwriteMunet: true },
  ])('rejects removed override options before opening a transaction: %j', async extra => {
    const transaction = vi.fn();
    const repository = new WorkspaceRepository({ transaction } as unknown as Database);

    await expect(repository.action('root', {
      type: 'import', source: 'lxns', raw: '[]', filename: 'scores.json', ...extra,
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
    expect(transaction).not.toHaveBeenCalled();
  });
});
