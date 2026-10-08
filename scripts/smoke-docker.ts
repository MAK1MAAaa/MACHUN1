/** Disposable Docker application + test MySQL only. No production .env or SSH. */
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareTestDatabase } from './mysql-test-fixture';
import { MysqlSourceStore } from '../server/accountService';
import { hashToken } from '../server/auth';
import type { BindingSubmission, BindingTask, CreatedBindingTask } from '../src/sourceBindingTypes';
import type { BrowserSource, SyncResult } from '../src/syncTypes';
// Node fetch discards a custom Host. Use HTTP/1 requests to emulate a real reverse proxy.
async function httpFetch(input: string, options: RequestInit = {}): Promise<Response> {
  const url = new URL(input);
  return new Promise((resolve, reject) => {
    const body = typeof options.body === 'string' ? options.body : undefined;
    const headers = { ...options.headers as Record<string, string>, ...(body !== undefined ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}) };
    const request = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname, method: options.method ?? 'GET', headers }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join('; ') : String(value));
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers }));
      });
      response.on('error', reject);
    });
    request.setTimeout(45_000, () => request.destroy(new Error('Local Docker request timed out')));
    request.on('error', reject); request.end(body);
  });
}
const fixture = await prepareTestDatabase();
const directory = await mkdtemp(join(tmpdir(), 'machun-docker-test-'));
const name = `machun1-test-app-${randomBytes(6).toString('hex')}`;
const image = process.env.MACHUN_TEST_IMAGE ?? 'machun1:companion-20261008-amd64';
let started = false;
const reports: Record<string, unknown>[] = [];
try {
  const parsed = new URL(fixture.url); parsed.hostname = 'host.docker.internal';
  const env = join(directory, 'app.env');
  await writeFile(env, `DATABASE_URL=${parsed}\nMACHUN_PUBLIC_ORIGIN=https://chuni.test.invalid\n`, { mode: 0o600 });
  execFileSync('docker', ['run', '--detach', '--rm', '--platform', 'linux/amd64', '--name', name, '--shm-size', '1g', '--publish', '127.0.0.1::1650', '--env-file', env, image], { stdio: ['ignore', 'pipe', 'inherit'] }); started = true;
  const endpoint = () => {
    const binding = JSON.parse(execFileSync('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', name], { encoding: 'utf8' }))['1650/tcp'][0];
    return `http://127.0.0.1:${binding.HostPort}`;
  };
  let origin = endpoint();
  async function ready() {
    for (let attempt = 0; attempt < 60; attempt++) {
      try { if ((await httpFetch(origin + '/healthz', { headers: { Host: 'chuni.test.invalid' } })).ok) return; } catch { /* starting */ }
      await delay(500);
    }
    throw new Error('Docker health endpoint did not become ready');
  }
  await ready();
  assert.deepEqual(await (await httpFetch(origin + '/healthz', { headers: { Host: 'chuni.test.invalid' } })).json(), { status: 'ok' });
  assert.equal((await httpFetch(origin + '/api/workspace', { headers: { Host: 'chuni.test.invalid' } })).status, 401);
  const headers = { Host: 'chuni.test.invalid', Origin: 'https://chuni.test.invalid', 'Content-Type': 'application/json', 'X-Machun-Request': '1' };
  const login = await httpFetch(origin + '/api/auth/login', { method: 'POST', headers, body: '{"username":"root","password":"pwd"}' });
  assert.equal(login.status, 200); assert(login.headers.get('set-cookie')?.includes('Secure'));
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  async function request<T>(path: string, method = 'GET', input?: unknown, code?: string): Promise<T> {
    const response = await httpFetch(origin + '/api' + path, { method, headers: { ...headers, ...(code ? { Authorization: `Bearer ${code}` } : { Cookie: cookie }) },
      ...(method !== 'GET' ? { body: JSON.stringify(input ?? {}) } : {}), signal: AbortSignal.timeout(45_000) });
    const payload = await response.json(); if (!response.ok) throw new Error(`${payload.code ?? response.status}: ${payload.error ?? 'request failed'}`); return payload;
  }
  const sources = await request<{ sources: { source: string; bindingMode: string }[] }>('/sources');
  assert.equal(sources.sources.filter(item => item.bindingMode === 'companion').length, 3);
  const task = await request<CreatedBindingTask>('/sources/rin/binding-tasks', 'POST');
  execFileSync('docker', ['restart', name], { stdio: 'ignore' }); origin = endpoint(); await ready();
  assert.equal((await request<BindingTask>(`/source-binding-tasks/${task.id}`)).status, 'expired');
  const own = new MysqlSourceStore(fixture.db, 'root', directory);
  const privateInput = process.env.MACHUN_PORTABILITY_FILE;
  if (privateInput) {
    const states: (BindingSubmission & { source: BrowserSource })[] = JSON.parse(await readFile(privateInput, 'utf8'));
    for (const state of states) {
      const report: Record<string, unknown> = { source: state.source };
      try {
        const created = await request<CreatedBindingTask>(`/sources/${state.source}/binding-tasks`, 'POST');
        await request(`/companion/binding-tasks/${created.id}`, 'POST', { session: state.session, identity: state.identity }, created.code);
        let task: BindingTask; const deadline = Date.now() + 60_000;
        do { await delay(1000); task = await request<BindingTask>(`/source-binding-tasks/${created.id}`); } while (task.status === 'validating' && Date.now() < deadline);
        assert.equal(task.status, 'complete', task.error ?? 'task validation timed out'); report.bindingTaskCommit = 'passed';
        const saved = await own.load(state.source); assert(saved.binding?.session); assert.equal(saved.binding?.identity.id, state.identity.id);
        assert.equal(saved.binding?.profile, undefined);
        const first = await request<SyncResult>(`/sources/${state.source}/sync`, 'POST');
        report.sync = 'passed'; report.records = first.records.length;
        assert(!JSON.stringify(first).includes(saved.binding!.session!.localStorage.token ?? 'never-export-token'));
        const snapshot = await own.load(state.source);
        assert.equal(snapshot.binding?.session?.source, state.source);
        execFileSync('docker', ['restart', name], { stdio: 'ignore' }); origin = endpoint(); await ready();
        const second = await request<SyncResult>(`/sources/${state.source}/sync`, 'POST'); report.restart = 'passed'; report.restartRecords = second.records.length;
        await request(`/sources/${state.source}/binding`, 'DELETE'); assert.equal((await own.load(state.source)).binding, null); report.unbind = 'passed';
      } catch (error) { report.error = error instanceof Error ? error.message : 'test failed'; }
      reports.push(report); console.log(JSON.stringify(report));
    }
  }
  const chromiumCheck = execFileSync('docker', ['exec', name, 'node', '--input-type=module', '-e',
    "import { chromium } from 'playwright'; const browser = await chromium.launch({headless:true}); const context = await browser.newContext(); const page = await context.newPage(); await page.goto('http://127.0.0.1:1650/healthz'); console.log(await page.textContent('body')); await browser.close();"], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(chromiumCheck.trim()), { status: 'ok' });
  // The only listener is the application; no desktop daemons or ports.
  const processes = execFileSync('docker', ['top', name], { encoding: 'utf8' }); assert(!/x11vnc|websockify|fluxbox|Xvfb/i.test(processes));
  const ports = JSON.parse(execFileSync('docker', ['inspect', '--format', '{{json .Config.ExposedPorts}}', name], { encoding: 'utf8' })); assert.deepEqual(Object.keys(ports), ['1650/tcp']);
  const user = execFileSync('docker', ['exec', name, 'id', '-u'], { encoding: 'utf8' }).trim(); assert.equal(user, '1000');
  assert.equal((await httpFetch(origin + '/login-view/vnc.html', { headers: { Host: 'chuni.test.invalid' } })).status, 404);
  const inspected = JSON.parse(execFileSync('docker', ['exec', name, 'node', '-e', "const fs=require('fs'); const rows=fs.readFileSync('/proc/net/tcp','utf8').trim().split('\\n').slice(1).filter(l=>l.trim().split(/\\s+/)[3]==='0A').map(l=>parseInt(l.trim().split(/\\s+/)[1].split(':')[1],16)); console.log(JSON.stringify(rows))"], { encoding: 'utf8' })); assert(!inspected.includes(5900)); assert(!inspected.includes(6080));
  console.log(JSON.stringify({ docker: 'passed', user, ports: Object.keys(ports), codesStoredOnlyHashed: hashToken(task.code) !== task.code, realPortals: reports }));
  if (reports.some(row => row.error)) process.exitCode = 1;
} finally {
  if (started) try { execFileSync('docker', ['stop', '--time', '5', name], { stdio: 'ignore' }); } catch { /* removed */ }
  await fixture.pool.end(); await fixture.admin.end(); await rm(directory, { recursive: true, force: true });
}
