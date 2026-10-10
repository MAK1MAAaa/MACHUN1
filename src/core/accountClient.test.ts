import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountClient, accountRequest, newerWorkspace } from './accountClient';
import { EMPTY_STATE } from './storage';
afterEach(() => vi.unstubAllGlobals());
describe('account API client', () => {
  it('keeps the latest workspace when concurrent responses arrive out of order', () => {
    const current = { state: structuredClone(EMPTY_STATE), revision: 4, legacyMigrated: true };
    const older = { ...current, revision: 3 };
    expect(newerWorkspace(current, older)).toBe(current);
    expect(newerWorkspace(current, { ...current, revision: 5 }).revision).toBe(5);
  });
  it('sends same-origin JSON actions without an arbitrary user identity', async () => {
    const fetcher = vi.fn(async () => Response.json({ revision: 2, state: EMPTY_STATE, legacyMigrated: false }));
    vi.stubGlobal('fetch', fetcher);
    await accountClient.action({ type: 'manual', key: '1:MAS', score: '1000000' });
    expect(fetcher).toHaveBeenCalledWith('/api/workspace/actions', expect.objectContaining({ method: 'POST', credentials: 'same-origin',
      headers: { 'X-Machun-Request': '1', 'Content-Type': 'application/json' }, body: '{"type":"manual","key":"1:MAS","score":"1000000"}' }));
  });
  it('reports network/database failures and only expires the web session for UNAUTHORIZED', async () => {
    const window = new EventTarget(); const expired = vi.fn(); window.addEventListener('machun-session-expired', expired);
    vi.stubGlobal('window', window);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(Response.json({ code: 'DATABASE_UNAVAILABLE', error: 'database offline' }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ code: 'BAD_CREDENTIALS', error: 'wrong login' }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ code: 'UNAUTHORIZED', error: 'expired' }, { status: 401 })));
    await expect(accountClient.workspace()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    await expect(accountClient.workspace()).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
    await expect(accountClient.login('root', 'bad')).rejects.toMatchObject({ code: 'BAD_CREDENTIALS' });
    expect(expired).not.toHaveBeenCalled();
    await expect(accountClient.workspace()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(expired).toHaveBeenCalledTimes(1);
  });
  it('does not log out a later user when an old aborted response returns', async () => {
    const window = new EventTarget(); const expired = vi.fn(); window.addEventListener('machun-session-expired', expired);
    vi.stubGlobal('window', window);
    const controller = new AbortController();
    vi.stubGlobal('fetch', async () => { controller.abort(); return Response.json({ code: 'UNAUTHORIZED' }, { status: 401 }); });
    await expect(accountRequest('/workspace', 'GET', undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(expired).not.toHaveBeenCalled();
  });
});
