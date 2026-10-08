import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createAppServer } from './http';
import type { AccountBackend } from './accountService';

let server: Server;
afterEach(async () => { if (server) { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); } });
describe('HTTPS account deployment', () => {
  it('uses user sessions with Secure cookies and exposes only neutral health metadata', async () => {
    const accounts = { auth: { account: vi.fn(async () => null), login: vi.fn(async () => ({ user: { username: 'alice' }, token: 'a'.repeat(64) })), logout: vi.fn() } } as unknown as AccountBackend;
    server = createAppServer({ accounts, publicOrigin: 'https://chuni.example' });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('port');
    const url = `http://127.0.0.1:${address.port}`;
    const headers = { Host: 'chuni.example', Origin: 'https://chuni.example', 'Content-Type': 'application/json', 'X-Machun-Request': '1' };
    const health = await fetch(url + '/healthz'); expect(await health.json()).toEqual({ status: 'ok' });
    const denied = await fetch(url + '/api/sources', { headers }); expect(denied.status).toBe(401); expect(denied.headers.get('www-authenticate')).toBeNull();
    const login = await fetch(url + '/api/auth/login', { method: 'POST', headers, body: '{"username":"alice","password":"test"}' });
    expect(login.status).toBe(200); expect(login.headers.get('set-cookie')).toContain('; Secure');
    expect(login.headers.get('set-cookie')).toContain('HttpOnly'); expect(login.headers.get('access-control-allow-origin')).toBeNull();
    const desktop = await fetch(url + '/login-view/vnc.html'); expect(desktop.status).toBe(404);
  });
});
