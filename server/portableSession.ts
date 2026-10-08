import type { BrowserContext } from 'playwright';
import type { PortableSession } from '../src/sourceBindingTypes';
import type { BrowserSource } from '../src/syncTypes';
import { SyncError } from './provider';

export const PORTAL_ORIGINS: Record<BrowserSource, string> = {
  rin: 'https://portal.naominet.live', munet: 'https://portal.mumur.net', otogame: 'https://u.otogame.net',
};
const KEYS: Record<BrowserSource, readonly string[]> = {
  rin: ['currentAccount'], munet: ['token', 'refreshToken', 'environmentKey'],
  otogame: ['TOKEN', 'ID_TOKEN', 'REFRESH_TOKEN'],
};
function invalid(): never { throw new SyncError('INVALID_SESSION', '登录会话格式无效，请重新运行登录助手。', 400); }
function text(value: unknown, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value) || value.length > 32768 || /[\r\n\x00-\x1f]/.test(value)) invalid();
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
export function validatePortableSession(source: BrowserSource, input: unknown): PortableSession {
  const value = object(input);
  if (value.version !== 1 || value.source !== source || Object.keys(value).some(key => !['version', 'source', 'localStorage'].includes(key))) invalid();
  const entries = object(value.localStorage);
  if (Object.keys(entries).some(key => !KEYS[source].includes(key))) invalid();
  const result: Record<string, string> = {};
  if (source === 'rin') {
    let account: Record<string, unknown>;
    try { account = object(JSON.parse(text(entries.currentAccount))); } catch { invalid(); }
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(text(account.tokenType))) invalid();
    result.currentAccount = JSON.stringify({ accessToken: text(account.accessToken), tokenType: account.tokenType,
      ...(account.refreshToken ? { refreshToken: text(account.refreshToken) } : {}) });
  } else if (source === 'munet') {
    result.token = text(entries.token);
    for (const key of ['refreshToken', 'environmentKey']) if (entries[key] !== undefined) result[key] = text(entries[key], true);
  } else {
    for (const key of KEYS.otogame) {
      if (entries[key] === undefined && key === 'REFRESH_TOKEN') continue;
      let stored: Record<string, unknown>;
      try { stored = object(JSON.parse(text(entries[key]))); } catch { invalid(); }
      if (stored.time !== undefined && (typeof stored.time !== 'number' || !Number.isFinite(stored.time))) invalid();
      if (stored.expire !== undefined && stored.expire !== null && (typeof stored.expire !== 'number' || !Number.isFinite(stored.expire))) invalid();
      result[key] = JSON.stringify({ value: text(stored.value), ...(stored.time === undefined ? {} : { time: stored.time }),
        ...(stored.expire === undefined ? {} : { expire: stored.expire }) });
    }
  }
  return { version: 1, source, localStorage: result };
}
export async function capturePortableSession(context: BrowserContext, source: BrowserSource): Promise<PortableSession> {
  const state = await context.storageState();
  const portal = state.origins.find(item => item.origin === PORTAL_ORIGINS[source]);
  const localStorage = Object.fromEntries((portal?.localStorage ?? []).filter(item => KEYS[source].includes(item.name)).map(item => [item.name, item.value]));
  return validatePortableSession(source, { version: 1, source, localStorage });
}
export function portableStorageState(session: PortableSession) {
  const clean = validatePortableSession(session.source, session);
  return { cookies: [], origins: [{ origin: PORTAL_ORIGINS[session.source], localStorage: Object.entries(clean.localStorage).map(([name, value]) => ({ name, value })) }] };
}
