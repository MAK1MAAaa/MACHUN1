import { afterEach, describe, expect, it, vi } from 'vitest';
import { workspaceClient, newerWorkspace } from './workspaceClient';
import { EMPTY_STATE } from './storage';
afterEach(() => vi.unstubAllGlobals());
describe('workspace API client', () => {
  it('keeps the latest workspace when concurrent responses arrive out of order', () => {
    const current = { state: structuredClone(EMPTY_STATE), revision: 4, legacyMigrated: true, exportNickname: '当前昵称' };
    const older = { ...current, revision: 3 };
    expect(newerWorkspace(current, older)).toBe(current);
    expect(newerWorkspace(current, { ...current, revision: 5, exportNickname: '新昵称' })).toMatchObject({ revision: 5, exportNickname: '新昵称' });
  });
  it('sends same-origin JSON actions without an arbitrary user identity', async () => {
    const fetcher = vi.fn(async () => Response.json({ revision: 2, state: EMPTY_STATE, legacyMigrated: false, exportNickname: '' }));
    vi.stubGlobal('fetch', fetcher);
    await workspaceClient.action({ type: 'manual', key: '1:MAS', score: '1000000' });
    expect(fetcher).toHaveBeenCalledWith('/api/workspace/actions', expect.objectContaining({ method: 'POST', credentials: 'same-origin',
      headers: { 'X-Machun-Request': '1', 'Content-Type': 'application/json' }, body: '{"type":"manual","key":"1:MAS","score":"1000000"}' }));
  });
  it('reads the local workspace and catalog without authenticating', async () => {
    const snapshot = { revision: 1, state: EMPTY_STATE, legacyMigrated: true, exportNickname: '' };
    const catalog = { date: '2026-11-01', version: 'Mate-2026-11-01-13plus', charts: [], details: [] };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(snapshot))
      .mockResolvedValueOnce(Response.json(catalog));
    vi.stubGlobal('fetch', fetcher);
    await expect(workspaceClient.workspace()).resolves.toEqual(snapshot);
    await expect(workspaceClient.catalog()).resolves.toEqual(catalog);
    expect(fetcher.mock.calls.map(([url, options]) => [url, options?.method]))
      .toEqual([['/api/workspace', 'GET'], ['/api/catalog', 'GET']]);
  });
  it('reports local service and database failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(Response.json({ code: 'DATABASE_UNAVAILABLE', error: 'database offline' }, { status: 503 })));
    await expect(workspaceClient.workspace()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    await expect(workspaceClient.workspace()).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
  });
  it('does not deliver a response after the request is aborted', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', async () => { controller.abort(); return Response.json({ revision: 1 }); });
    await expect(workspaceClient.workspace(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
