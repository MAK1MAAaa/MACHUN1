import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SourceManager } from './manager';
import { SourceStore } from './store';
import type { BrowserProvider, BrowserSession } from './provider';
import { SyncError } from './provider';
import { catalog, CATALOG_VERSION } from '../src/core/catalog';
import type { PortableSession } from '../src/sourceBindingTypes';

const state: PortableSession = { version: 1, source: 'otogame', localStorage: { TOKEN: '{"value":"access"}', ID_TOKEN: '{"value":"id"}', REFRESH_TOKEN: '{"value":"renew"}' } };
const identity = { id: 'test-account', label: '测试卡', cardId: 'test-card' };
const folders: string[] = []; const managers: SourceManager[] = [];
afterEach(async () => { await Promise.all(managers.map(manager => manager.close())); managers.length = 0; await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup() {
  const path = await mkdtemp(join(tmpdir(), 'machun-portable-test-')); folders.push(path);
  const store = new SourceStore(path); await store.initialize();
  const provider: BrowserProvider = { source: 'otogame', loginUrl: 'https://u.otogame.net/', identify: vi.fn(async () => identity), fetchScores: vi.fn(async () => []) };
  const close = vi.fn(async () => undefined);
  const storage = vi.fn(async () => ({ cookies: [{ name: 'secret', value: 'not-exported' }], origins: [{ origin: 'https://u.otogame.net', localStorage: Object.entries(state.localStorage).map(([name, value]) => ({ name, value })) }] }));
  const session = { context: { close, storageState: storage }, page: {} } as unknown as BrowserSession;
  const launcher = { open: vi.fn(), openPortable: vi.fn(async () => session) };
  const options = { store, providers: { rin: provider, munet: provider, otogame: provider }, launcher, companionLogin: true };
  const manager = new SourceManager(options); managers.push(manager); await manager.initialize();
  return { store, provider, manager, launcher, storage, options };
}
describe('portable source binding and persistence', () => {
  it('validates identity before replacing a binding and preserves history when the card matches', async () => {
    const { manager, store } = await setup();
    const chart = catalog[0];
    const old = { binding: { identity, session: state }, lastAttemptAt: null, lastSuccessAt: null, otogameCache: { identity,
      records: [{ ...chart, score: 1_005_000, rating: chart.constant, source: 'otogame' as const, updatedAt: 'test' }],
      checkpoint: { timestamp: 1, boundaryKeys: ['a'.repeat(64)] }, catalogVersion: CATALOG_VERSION, strategy: 'playlog' as const } };
    await store.save('otogame', old); await manager.initialize();
    await expect(manager.bindPortable('otogame', state, { ...identity, cardId: 'other' })).rejects.toMatchObject({ code: 'IDENTITY_CHANGED' });
    expect(await store.load('otogame')).toEqual(old);
    await manager.bindPortable('otogame', state, identity);
    expect((await store.load('otogame')).otogameCache).toEqual(old.otogameCache);
    expect(JSON.stringify(manager.connections())).not.toMatch(/access|renew|localStorage/);
  });
  it('does not commit a cancelled or failed validation and allows a later retry', async () => {
    const { manager, store, provider } = await setup();
    const abort = new AbortController();
    vi.mocked(provider.identify).mockImplementationOnce(async () => { abort.abort(); return identity; });
    await expect(manager.bindPortable('otogame', state, identity, undefined, abort.signal)).rejects.toMatchObject({ code: 'TASK_CANCELLED' });
    expect((await store.load('otogame')).binding).toBeNull();
    vi.mocked(provider.identify).mockRejectedValueOnce(new SyncError('AUTH_REQUIRED', '过期', 401));
    await expect(manager.bindPortable('otogame', state, identity)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect((await store.load('otogame')).binding).toBeNull();
    await manager.bindPortable('otogame', state, identity);
    expect(manager.connections().find(item => item.source === 'otogame')?.bound).toBe(true);
  });
  it('persists renewed minimal state and restores it after restart without a profile directory', async () => {
    const { manager, store, launcher, storage, options, provider } = await setup();
    await manager.bindPortable('otogame', state, identity);
    const renewed = { ...state.localStorage, TOKEN: '{"value":"new-access"}' };
    storage.mockResolvedValue({ cookies: [], origins: [{ origin: 'https://u.otogame.net', localStorage: Object.entries(renewed).map(([name, value]) => ({ name, value })) }] });
    vi.mocked(provider.fetchScores).mockResolvedValue([{ id: catalog[0].id, difficulty: catalog[0].difficulty, score: 1_005_000 }]);
    await manager.sync('otogame');
    expect((await store.load('otogame')).binding?.session?.localStorage.TOKEN).toBe(renewed.TOKEN);
    const restart = new SourceManager(options); managers.push(restart); await restart.initialize(); await restart.sync('otogame');
    expect(launcher.openPortable).toHaveBeenLastCalledWith(expect.objectContaining({ localStorage: renewed }), provider.loginUrl);
    expect(launcher.open).not.toHaveBeenCalled();
    await restart.unbind('otogame'); expect((await store.load('otogame')).binding).toBeNull();
  });
});
