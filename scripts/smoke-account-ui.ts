/** Real Chromium + disposable local MySQL, with fake score portals only. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Browser, type Page } from 'playwright';
import { eq } from 'drizzle-orm';
import { prepareTestDatabase } from './mysql-test-fixture';
import { AccountService, MysqlSourceStore } from '../server/accountService';
import { createAppServer, type HttpManager } from '../server/http';
import { users, workspaces, bindingTasks } from '../server/db/schema';
import { hashPassword } from '../server/auth';
import { createDatabase } from '../server/db/connection';
import { catalog } from '../src/core/catalog';
import { calculateRating } from '../src/core/rating';
import { EMPTY_STATE, STORAGE_KEY } from '../src/core/storage';
import { SYNC_SOURCES, type SourceConnection, type SyncResult } from '../src/syncTypes';
import type { ExternalScoreSource } from '../src/core/sources';
import type { LocalState, SingleRating } from '../src/types';
import { SyncError } from '../server/provider';

let fixture = await prepareTestDatabase();
const directory = await mkdtemp(join(tmpdir(), 'machun-account-ui-'));
let service = new AccountService(fixture.db, directory, directory);
const first = catalog[0]; const key = `${first.id}:${first.difficulty}`;
const seed: LocalState = { ...structuredClone(EMPTY_STATE),
  scores: Object.fromEntries(catalog.slice(0, 50).map((chart, index) => [`${chart.id}:${chart.difficulty}`, {
    id: chart.id, title: chart.title, difficulty: chart.difficulty, constant: chart.constant,
    score: 1_000_000 + index, rating: 99, source: index % 2 ? 'rin' : 'munet', updatedAt: '2026-10-08T10:00:00.000Z', combo: 'fc',
  }])), nicknameOverrides: { [first.id]: ['迁移别名'] } };
class FakeManager implements HttpManager {
  readonly state = new Map<ExternalScoreSource, SourceConnection>(SYNC_SOURCES.map(source => [source, {
    source, bound: false, status: 'unbound', identity: null, lastAttemptAt: null, lastSuccessAt: null, error: null,
  }]));
  calls = 0;
  nextScore = 1_006_000;
  fail = false;
  hold?: Promise<void>;
  release?: () => void;
  constructor(private readonly store: MysqlSourceStore) {}
  connections() { return structuredClone([...this.state.values()]); }
  async bind(source: ExternalScoreSource, token?: string) {
    const identity = { id: `${this.store.username}-${source}`, label: `${this.store.username} 的测试卡` };
    await this.store.initialize();
    const binding = source === 'lxns' ? { identity, token } : { identity, profile: await this.store.newProfile(source) };
    await this.store.save(source, { binding, lastAttemptAt: null, lastSuccessAt: null });
    const connection: SourceConnection = { ...this.state.get(source)!, bound: true, status: 'ready', identity };
    this.state.set(source, connection); return structuredClone(connection);
  }
  async unbind(source: ExternalScoreSource) {
    await this.store.save(source, { binding: null, lastAttemptAt: null, lastSuccessAt: null });
    const connection: SourceConnection = { ...this.state.get(source)!, bound: false, status: 'unbound', identity: null };
    this.state.set(source, connection); return structuredClone(connection);
  }
  wait() { this.hold = new Promise(resolve => { this.release = resolve; }); }
  async sync(source: ExternalScoreSource): Promise<SyncResult> {
    if (this.state.get(source)?.status === 'syncing') throw new SyncError('BUSY', '正在同步', 409);
    this.calls++;
    this.state.get(source)!.status = 'syncing';
    if (this.hold) { await this.hold; this.hold = undefined; }
    this.state.get(source)!.status = 'ready';
    if (this.fail) throw new SyncError('HTTP_ERROR', '模拟来源请求失败', 502);
    const records: SingleRating[] = [{ ...seed.scores[key], score: this.nextScore, source, combo: 'aj', fullChain: 'platinum', rating: calculateRating(this.nextScore, first.constant) }];
    return { source, records, report: { parsedScores: 1, importedScores: 1, updatedScores: 0, skippedScores: 0, unknownCharts: 0, invalidEntries: 0 }, connection: this.connections().find(row => row.source === source)! };
  }
}
const managers = new Map<string, FakeManager>();
const server = createAppServer({ accounts: { get bindingTasks() { return service.bindingTasks; }, get auth() { return service.auth; }, get workspace() { return service.workspace; }, catalog: () => service.catalog(),
  async manager(username) {
    let manager = managers.get(username);
    if (!manager) { manager = new FakeManager(new MysqlSourceStore(fixture.db, username, directory)); managers.set(username, manager); }
    return manager;
  },
}, distDirectory: fileURLToPath(new URL('../dist/', import.meta.url)) });
let browser: Browser | undefined;
let paused = false;
const container = process.env.MACHUN_TEST_CONTAINER!;
const output = await mkdtemp(join(tmpdir(), 'machun-account-ui-artifacts-'));
const pageErrors: string[] = [];
const mark = (message: string) => console.log(`PASS ${message}`);
async function login(page: Page, username: string, password: string) {
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.locator('.account-toolbar').waitFor();
}
async function state(page: Page) {
  return page.evaluate(async () => { const response = await fetch('/api/workspace'); if (!response.ok) throw new Error('workspace error'); return (await response.json()).state as LocalState; });
}
async function score(page: Page, expected: number, source?: SingleRating['source']) {
  await page.waitForFunction(async ({ key, expected, source }) => {
    const response = await fetch('/api/workspace'); if (!response.ok) return false;
    const current = (await response.json()).state.scores[key]; return current?.score === expected && (!source || current.source === source);
  }, { key, expected, source });
  await page.locator('.record-table tbody tr').first().waitFor();
}
async function edit(page: Page, value: number) {
  const section = page.locator('.records-browser');
  await section.getByRole('button', { name: 'Rating 排名', exact: true }).click();
  await section.getByRole('searchbox').fill(first.id);
  const row = page.locator('.record-table tbody tr').filter({ has: page.getByText(first.difficulty, { exact: true }) });
  await row.getByRole('button', { name: '修改分数', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '修改分数', exact: true });
  await dialog.getByLabel('分数', { exact: true }).fill(String(value));
  await dialog.getByRole('button', { name: '保存修改', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await score(page, value, 'manual'); await section.getByRole('searchbox').fill('');
}
try {
  await fixture.db.insert(users).values({ username: 'ui-second', pwd: hashPassword('second-pwd') }).onDuplicateKeyUpdate({ set: { pwd: hashPassword('second-pwd') } });
  for (const username of ['root', 'ui-second']) await service.workspace.action(username, { type: 'clear' });
  await fixture.db.update(workspaces).set({ legacyMigrated: false }).where(eq(workspaces.username, 'root'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const cover = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1cAAAAASUVORK5CYII=', 'base64');
  await context.route('https://otoge-db.net/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: cover, headers: { 'access-control-allow-origin': '*' } }));
  await context.addInitScript({ content: `if (location.origin === ${JSON.stringify(origin)} && !localStorage.getItem(${JSON.stringify(STORAGE_KEY)})) localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(seed))});` });
  const page = await context.newPage(); page.setDefaultTimeout(15_000); page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(origin); await page.getByRole('button', { name: '登录', exact: true }).waitFor();
  assert.equal(await page.locator('.records-browser').count(), 0);
  assert.equal(await page.getByText('注册', { exact: true }).count(), 0);
  await page.screenshot({ path: join(output, 'login.png') });
  await login(page, 'root', 'pwd');
  assert.equal(Object.keys((await state(page)).scores).length, 50);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY), JSON.stringify(seed));
  assert.equal(await page.locator('.record-table tbody tr').count(), 10);
  mark('root login migrates 50 legacy scores and one alias while keeping the old browser copy');
  const toggle = page.locator('.b30-preview-toggle');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  await toggle.click();
  assert.equal(await page.locator('.b30-card').count(), 30);
  assert.equal(await page.locator('.b30-grid').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length), 3);
  assert((await page.locator('.b30-card').first().innerText()).includes('FC'));
  await toggle.click();
  await edit(page, 1_001_000);
  await page.reload(); await page.locator('.account-toolbar').waitFor(); await score(page, 1_001_000, 'manual');
  mark('manual score, achievements and source survive refresh; legacy migration does not repeat');
  const section = page.locator('.records-browser');
  await section.getByRole('button', { name: '曲库筛选', exact: true }).click();
  await page.getByLabel('等级', { exact: true }).selectOption('13');
  assert.deepEqual(await page.getByLabel('定数', { exact: true }).locator('option').allTextContents(), ['全部定数', '13.0', '13.1', '13.2', '13.3', '13.4']);
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await page.getByRole('button', { name: '显示未游玩谱面', exact: true }).click();
  await section.getByRole('searchbox').fill('3055');
  await page.getByRole('button', { name: '查看歌曲详情：SAN値直葬', exact: true }).click();
  const song = page.getByRole('dialog');
  assert.equal(await song.getByLabel('EXP 定数', { exact: true }).innerText(), '12.5');
  assert.equal(await song.getByLabel('ULT 定数', { exact: true }).innerText(), '/');
  await song.getByLabel('个人别名', { exact: true }).fill('个人测试别名');
  await song.getByRole('button', { name: '保存个人别名', exact: true }).click();
  await song.getByText('个人别名已保存。', { exact: true }).waitFor();
  await song.getByRole('button', { name: '关闭歌曲详情', exact: true }).click();
  await section.getByRole('searchbox').fill('个人测试别名'); assert.equal(await page.locator('.record-table tbody tr').count(), 1);
  mark('catalog filters, pagination, new low-level details and personal aliases work in the database workspace');
  await section.getByRole('searchbox').fill(''); await section.getByRole('button', { name: 'Rating 排名', exact: true }).click();
  await page.locator('.source-tools-toggle').click();
  const card = page.locator('.source-card.rin');
  await card.getByRole('button', { name: '绑定账号', exact: true }).click();
  await card.locator('.source-connection-status').filter({ hasText: /^已绑定$/ }).waitFor();
  const manager = managers.get('root')!;
  manager.wait();
  await card.getByRole('button', { name: '同步成绩', exact: true }).click();
  await card.locator('.source-connection-status').filter({ hasText: /^正在同步$/ }).waitFor();
  assert(await card.getByRole('button', { name: '正在同步', exact: true }).isDisabled());
  await edit(page, 1_002_000); manager.release!();
  await score(page, 1_006_000, 'rin');
  await card.locator('.source-connection-status').filter({ hasText: /^已绑定$/ }).waitFor();
  assert.equal(manager.calls, 1);
  assert.equal((await state(page)).scores[key].combo, 'aj');
  manager.fail = true;
  await card.getByRole('button', { name: '同步成绩', exact: true }).click();
  await card.getByText('模拟来源请求失败', { exact: true }).waitFor();
  assert.equal((await state(page)).scores[key].score, 1_006_000); manager.fail = false;
  mark('sync preserves manual edits made while waiting, suppresses repeat clicks and keeps data on provider failure');
  await page.locator('.local-tools-toggle').click();
  const backupDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出完整备份', exact: true }).click();
  const backup = await backupDownload; const path = await backup.path(); assert(path);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.scores.length, 50);
  assert(saved.scores.some((row: SingleRating) => row.combo === 'aj' && row.fullChain === 'platinum'));
  assert.equal(saved.nicknameOverrides['3055'][0], '个人测试别名');
  assert(!JSON.stringify(saved).includes('token'));
  await edit(page, 1_005_000);
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '导入完整备份', exact: true }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: 'full-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(saved)) });
  await score(page, 1_006_000, 'rin');
  mark('full backup import restores all records, personal aliases, source and AJ/full-chain marks');
  for (const name of ['导出 B30 图片', '导出 B30 + 候选20 图片']) {
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name, exact: true }).click();
    const download = await downloadPromise; const file = await download.path(); assert(file);
    const png = await readFile(file); assert.equal(png.readUInt32BE(16), 2360);
    assert.equal(png.readUInt32BE(20), name.includes('候选20') ? 1792 : 1120);
    await download.saveAs(join(output, download.suggestedFilename()));
  }
  mark('full JSON backup and both 5-column PNG exports retain source, FC/AJ and grades');
  paused = true; execFileSync('docker', ['pause', container], { stdio: 'ignore' });
  // Pausing holds TCP connections; destroy them so MySQL fails promptly instead of hanging.
  await fixture.pool.end();
  await section.getByRole('searchbox').fill(first.id);
  const row = page.locator('.record-table tbody tr').filter({ has: page.getByText(first.difficulty, { exact: true }) });
  await row.getByRole('button', { name: '修改分数', exact: true }).click();
  const editDialog = page.getByRole('dialog', { name: '修改分数', exact: true });
  await editDialog.getByLabel('分数', { exact: true }).fill('900000');
  await editDialog.getByRole('button', { name: '保存修改', exact: true }).click();
  await editDialog.getByRole('alert').waitFor();
  assert((await row.innerText()).includes('1,006,000'));
  await editDialog.getByRole('button', { name: '取消', exact: true }).click();
  execFileSync('docker', ['unpause', container], { stdio: 'ignore' }); paused = false;
  mark('database failure never reports a successful save or erases the visible scores');
  await service.close();
  fixture = { ...fixture, ...createDatabase(fixture.url) };
  service = new AccountService(fixture.db, directory, directory);
  await page.getByRole('button', { name: '重新读取', exact: true }).click();
  await page.locator('.status-banner.error').waitFor({ state: 'hidden' });
  await score(page, 1_006_000, 'rin');
  // The previous user's in-flight response must not populate the next user's page.
  manager.wait();
  await card.getByRole('button', { name: '同步成绩', exact: true }).click();
  await card.locator('.source-connection-status').filter({ hasText: /^正在同步$/ }).waitFor();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('button', { name: '登录', exact: true }).waitFor();
  await login(page, 'ui-second', 'second-pwd'); manager.release!();
  await delay(150);
  assert.deepEqual(await state(page), EMPTY_STATE);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY), JSON.stringify(seed));
  await page.locator('.source-tools-toggle').click();
  assert.equal(await page.locator('.source-connection-status').filter({ hasText: /^未绑定$/ }).count(), 4);
  mark('logout revokes the session; the next user sees no root scores, aliases or bindings, even after a delayed sync');
  const secondContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await secondContext.route('https://otoge-db.net/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: cover }));
  const mobile = await secondContext.newPage(); mobile.setDefaultTimeout(15_000);
  await mobile.goto(origin); await login(mobile, 'root', 'pwd');
  assert.equal(Object.keys((await state(mobile)).scores).length, 50);
  assert.equal((await state(mobile)).nicknameOverrides['3055'][0], '个人测试别名');
  assert.equal(await mobile.evaluate(key => localStorage.getItem(key), STORAGE_KEY), null);
  await mobile.locator('.source-tools-toggle').click();
  const mobileManager = managers.get('root')!;
  for (const connection of mobileManager.state.values()) if (connection.source !== 'lxns') connection.bindingMode = 'companion';
  await mobile.reload(); await mobile.locator('.source-tools-toggle').click();
  const mobileCard = mobile.locator('.source-card.rin');
  await mobileCard.getByRole('button', { name: '重新登录', exact: true }).click();
  await mobileCard.getByRole('button', { name: '生成绑定任务', exact: true }).click();
  const command = mobileCard.getByLabel('助手命令', { exact: true }); await command.waitFor();
  const commandText = await command.inputValue();
  assert(commandText.includes('pnpm login:remote --server ')); assert(commandText.includes(' --task '));
  const code = await mobileCard.getByLabel('绑定码', { exact: true }).inputValue(); assert.equal(code.length, 43); assert(!commandText.includes(code));
  const beforeCancel = await state(mobile);
  for (const width of [320, 390, 768, 1440]) {
    await mobile.setViewportSize({ width, height: 900 });
    assert(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `mobile viewport ${width} overflow`);
  }
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobileCard.locator('.companion-binding').screenshot({ path: join(output, 'mobile-companion-binding.png') });
  await mobileCard.getByRole('button', { name: '取消绑定任务', exact: true }).click();
  assert.deepEqual(await state(mobile), beforeCancel);
  await mobileCard.getByRole('button', { name: '重新登录', exact: true }).click();
  await mobileCard.getByRole('button', { name: '生成绑定任务', exact: true }).click();
  await command.waitFor(); const nextCommand = await command.inputValue(); const taskId = nextCommand.split(' --task ')[1];
  await fixture.db.update(bindingTasks).set({ status: 'complete' }).where(eq(bindingTasks.id, taskId));
  await mobileCard.locator('.companion-binding').getByRole('status').filter({ hasText: /^绑定成功$/ }).waitFor();
  await mobileCard.getByRole('button', { name: '关闭', exact: true }).click();
  assert(await mobileCard.getByRole('button', { name: '同步成绩', exact: true }).isEnabled());
  assert.equal(await mobile.locator('iframe').count(), 0);
  mark('companion command/code, cancelled task preservation, completion polling and 320/390/768/1440 layouts pass without a remote desktop');
  await mobile.screenshot({ path: join(output, 'mobile-root.png'), fullPage: true });
  await secondContext.close(); await context.close();
  mark('a fresh browser reads root data from MySQL without localStorage, and login works at mobile width');
  assert.deepEqual(pageErrors, []);
  console.log(`浏览器截图与导出结果：${output}`);
} finally {
  for (const manager of managers.values()) manager.release?.();
  if (paused) execFileSync('docker', ['unpause', container], { stdio: 'ignore' });
  await browser?.close(); await service.close();
  await new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections();
  await fixture.pool.end().catch(() => undefined); await fixture.admin.end();
  await rm(directory, { recursive: true, force: true });
}
