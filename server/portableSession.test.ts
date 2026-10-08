import { describe, expect, it } from 'vitest';
import { capturePortableSession, portableStorageState, validatePortableSession } from './portableSession';
import type { BrowserContext } from 'playwright';
import { remoteServer } from '../scripts/login-remote';

describe('minimal portable portal sessions', () => {
  it('retains Rin tokens and excludes embedded passwords, account metadata and cookies', async () => {
    const context = { storageState: async () => ({ cookies: [{ name: 'BCN_SSO', value: 'private-cookie' }], origins: [
      { origin: 'https://portal.naominet.live', localStorage: [{ name: 'currentAccount', value: JSON.stringify({ accessToken: 'access', tokenType: 'Bearer', refreshToken: 'renew', password: 'private-password', email: 'private-email' }) }, { name: 'password', value: 'secret' }] },
      { origin: 'https://bemanicn.com', localStorage: [{ name: 'sso', value: 'secret' }] },
    ] }) } as unknown as BrowserContext;
    const session = await capturePortableSession(context, 'rin');
    expect(JSON.stringify(session)).not.toMatch(/secret|private-|BCN_SSO|email|password/);
    expect(portableStorageState(session)).toEqual({ cookies: [], origins: [{ origin: 'https://portal.naominet.live', localStorage: [{ name: 'currentAccount', value: '{"accessToken":"access","tokenType":"Bearer","refreshToken":"renew"}' }] }] });
  });
  it('retains MuNET renewal and environment fields, including an empty environment key', () => {
    expect(validatePortableSession('munet', { version: 1, source: 'munet', localStorage: { token: 'jwt', refreshToken: 'renew', environmentKey: '' } }).localStorage).toEqual({ token: 'jwt', refreshToken: 'renew', environmentKey: '' });
  });
  it('retains only Otogame tokens and expiry metadata', () => {
    const wrapped = JSON.stringify({ value: 'token', time: 1, expire: 100, email: 'secret' });
    const session = validatePortableSession('otogame', { version: 1, source: 'otogame', localStorage: { TOKEN: wrapped, ID_TOKEN: wrapped, REFRESH_TOKEN: wrapped } });
    expect(JSON.parse(session.localStorage.TOKEN)).toEqual({ value: 'token', time: 1, expire: 100 });
  });
  it.each([
    { version: 1, source: 'rin', localStorage: {}, cookies: [] },
    { version: 1, source: 'munet', localStorage: { token: 'jwt' } },
    { version: 1, source: 'rin', localStorage: { currentAccount: 'invalid' } },
    { version: 1, source: 'rin', localStorage: { currentAccount: '{"accessToken":"access","tokenType":"Bearer"}', password: 'secret' } },
  ])('rejects wrong sources, unknown fields and malformed state without echoing secrets', value => {
    expect(() => validatePortableSession('rin', value)).toThrow('登录会话格式无效');
  });
  it('accepts HTTPS or direct IP HTTP on 1650, while refusing arbitrary domains and URL credentials', () => {
    expect(remoteServer('https://chuni.example:1650/')).toBe('https://chuni.example:1650');
    expect(remoteServer('http://127.0.0.1:1650')).toBe('http://127.0.0.1:1650');
    expect(remoteServer('http://203.0.113.12:1650')).toBe('http://203.0.113.12:1650');
    expect(remoteServer('http://[2001:db8::12]:1650')).toBe('http://[2001:db8::12]:1650');
    expect(remoteServer('http://localhost:4399')).toBe('http://localhost:4399');
    expect(() => remoteServer('http://203.0.113.12:4399')).toThrow();
    for (const value of ['http://public.example', 'https://user:pwd@example.com', 'https://example.com/path', 'https://example.com?code=secret']) expect(() => remoteServer(value)).toThrow();
  });
});
