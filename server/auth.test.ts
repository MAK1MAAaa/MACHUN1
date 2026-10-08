import { describe, expect, it } from 'vitest';
import { hashPassword, readSessionCookie, sessionCookie, SESSION_SECONDS } from './auth';
describe('account credentials and cookies', () => {
  it('uses lowercase UTF-8 SHA-256 and hashes case distinctly', () => {
    expect(hashPassword('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hashPassword('pwd')).toMatch(/^[a-f0-9]{64}$/);
    expect(hashPassword('Pwd')).not.toBe(hashPassword('pwd'));
  });
  it('issues a seven-day HttpOnly same-origin cookie and clears it on logout', () => {
    const token = 'a'.repeat(64);
    expect(sessionCookie(token)).toBe(`machun_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}`);
    expect(sessionCookie('', true)).toContain('Max-Age=0');
    expect(readSessionCookie(`other=value; machun_session=${token}; another=1`)).toBe(token);
    for (const bad of ['machun_session=secret', 'machun_session=' + 'A'.repeat(64), '', 'machun_session=' + 'a'.repeat(63)]) expect(readSessionCookie(bad)).toBeNull();
  });
});
