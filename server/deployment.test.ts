import { afterEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequest, type Server } from 'node:http';
import { createAppServer } from './http';
import type { AccountBackend } from './accountService';

let server: Server;
afterEach(async () => { if (server) { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); } });
describe('HTTPS account deployment', () => {
  it('accepts root / pwd on a direct HTTP IP without Basic Auth or a Secure-only cookie', async () => {
    const accounts = { auth: { account: vi.fn(async () => null), login: vi.fn(async () => ({ user: { username: 'root' }, token: 'a'.repeat(64) })), logout: vi.fn() } } as unknown as AccountBackend;
    server = createAppServer({ accounts, publicIpAccess: true });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('port');
    const response = await new Promise<{ status: number; cookie: string; body: string; challenge: unknown }>((resolve, reject) => {
      const content = '{"username":"root","password":"pwd"}';
      const host = `203.0.113.12:${address.port}`;
      const request = httpRequest({ hostname: '127.0.0.1', port: address.port, path: '/api/auth/login', method: 'POST', headers: {
        Host: host, Origin: `http://${host}`, 'Content-Type': 'application/json', 'X-Machun-Request': '1', 'Content-Length': Buffer.byteLength(content),
      } }, response => {
        let body = ''; response.setEncoding('utf8'); response.on('data', value => body += value);
        response.on('end', () => resolve({ status: response.statusCode!, cookie: response.headers['set-cookie']?.[0] ?? '', body, challenge: response.headers['www-authenticate'] }));
      });
      request.on('error', reject); request.end(content);
    });
    expect(response.status).toBe(200);
    expect(response.challenge).toBeUndefined();
    expect(response.cookie).toContain('HttpOnly; SameSite=Lax');
    expect(response.cookie).not.toContain('Secure');
    expect(JSON.parse(response.body)).toEqual({ user: { username: 'root' } });
    expect(accounts.auth.login).toHaveBeenCalledWith({ username: 'root', password: 'pwd' }, '127.0.0.1');
  });
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
