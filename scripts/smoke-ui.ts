import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { loadLocalCatalog, openLocalDatabase } from '../server/db/sqlite';
import { SqliteSourceStore } from '../server/db/sqliteSourceStore';
import { createAppServer } from '../server/http';
import { SourceManager } from '../server/manager';
import { munetProvider } from '../server/providers/munet';
import { otogameProvider } from '../server/providers/otogame';
import { rinProvider } from '../server/providers/rin';
import { WorkspaceRepository } from '../server/workspace';
import type { WorkspaceSnapshot } from '../src/accountTypes';
import { chartKey } from '../src/core/b30';
import { formatScore } from '../src/core/rating';
import { STORAGE_KEY } from '../src/core/storage';

const catalog = loadLocalCatalog();
const chart = catalog.charts[0];
const key = chartKey(chart);
const dataDirectory = await mkdtemp(join(tmpdir(), 'machun-smoke-ui-'));
const distDirectory = fileURLToPath(new URL('../dist/', import.meta.url));
const legacy = { schemaVersion: 2, scores: {}, nicknameOverrides: { [chart.id]: ['测试专用别名'] } };
let browser: Browser | undefined;
let running: Awaited<ReturnType<typeof startServer>> | undefined;

async function startServer() {
  const connection = openLocalDatabase(dataDirectory);
  const manager = new SourceManager({
    store: new SqliteSourceStore(connection.db, dataDirectory),
    providers: { munet: munetProvider, otogame: otogameProvider, rin: rinProvider },
  });
  const server = createAppServer({
    catalog, distDirectory, workspace: new WorkspaceRepository(connection.db),
    manager: async () => manager,
  });
  try {
    await manager.initialize();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    await manager.close();
    connection.close();
    throw error;
  }
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      try {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      } finally {
        try { await manager.close(); } finally { connection.close(); }
      }
    },
  };
}

async function openWorkspace(page: Page, origin: string) {
  const unexpected: string[] = [];
  page.on('pageerror', error => unexpected.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith('/api/auth/')) unexpected.push(url.pathname);
    return route.continue();
  });
  await page.goto(origin);
  await page.getByRole('heading', { name: 'MACHUN1', exact: true }).waitFor();
  const toolbar = page.getByRole('region', { name: '本地数据' });
  assert.deepEqual(await toolbar.getByRole('button').allTextContents(), ['导入备份', '导出备份', '清除数据']);
  assert.equal(await page.getByRole('button', { name: '退出登录' }).count(), 0);
  assert.equal(await page.locator('[autocomplete="username"]').count(), 0);
  assert(await toolbar.evaluate(element => element.scrollWidth <= element.clientWidth));
  return { toolbar, unexpected };
}

async function workspace(page: Page): Promise<WorkspaceSnapshot> {
  const response = await page.request.get('/api/workspace');
  assert(response.ok());
  return response.json();
}

async function chartRow(page: Page) {
  await page.getByRole('button', { name: '展开全部成绩', exact: true }).click();
  await page.getByRole('searchbox', { name: '搜索' }).fill(chart.id);
  return page.getByRole('row').filter({ has: page.getByText(`ID ${chart.id}`, { exact: true }) })
    .filter({ has: page.getByText(chart.difficulty, { exact: true }) });
}

try {
  running = await startServer();
  browser = await chromium.launch({ channel: existsSync(chromium.executablePath()) ? 'chromium' : 'chrome' });
  const clean = await browser.newPage({ baseURL: running.origin });
  const cleanStart = await openWorkspace(clean, running.origin);
  assert.equal((await workspace(clean)).legacyMigrated, false, 'an empty browser must not consume the legacy migration');
  assert.deepEqual(cleanStart.unexpected, []);
  await clean.close();

  const desktop = await browser.newContext({ baseURL: running.origin, viewport: { width: 1440, height: 900 } });
  await desktop.addInitScript(({ storageKey, snapshot }) => localStorage.setItem(storageKey, JSON.stringify(snapshot)), { storageKey: STORAGE_KEY, snapshot: legacy });
  const page = await desktop.newPage();
  const { toolbar, unexpected } = await openWorkspace(page, running.origin);
  const migrated = await workspace(page);
  assert(migrated.legacyMigrated);
  assert.deepEqual(migrated.state.nicknameOverrides, legacy.nicknameOverrides);
  await page.getByRole('button', { name: '展开成绩来源' }).click();
  for (const source of ['munet', 'rin', 'otogame']) {
    const card = page.locator(`.source-card.${source}`);
    await card.getByText('未绑定', { exact: true }).waitFor();
    assert(await card.getByRole('button', { name: '绑定账号', exact: true }).isEnabled());
  }

  const row = await chartRow(page);
  await page.getByRole('button', { name: '显示未游玩谱面' }).click();
  await row.getByRole('button', { name: '录入分数' }).click();
  const scoreDialog = page.getByRole('dialog', { name: '录入分数' });
  const score = 1_005_000;
  await scoreDialog.getByLabel('分数', { exact: true }).fill(String(score));
  await scoreDialog.getByRole('button', { name: '保存修改' }).click();
  await row.getByText(formatScore(score), { exact: true }).waitFor();
  assert.equal((await workspace(page)).state.scores[key].score, score);

  await page.getByLabel('导出昵称', { exact: true }).fill('SQLite 测试玩家');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('导出昵称已保存。', { exact: true }).waitFor();
  const [download] = await Promise.all([
    page.waitForEvent('download'), toolbar.getByRole('button', { name: '导出备份' }).click(),
  ]);
  const backupPath = await download.path();
  assert(backupPath);
  const backup = JSON.parse(await readFile(backupPath, 'utf8'));
  assert.equal(backup.scores[0].score, score);
  assert.deepEqual(backup.nicknameOverrides, legacy.nicknameOverrides);

  const clear = page.waitForEvent('dialog').then(dialog => dialog.accept());
  await Promise.all([clear, toolbar.getByRole('button', { name: '清除数据' }).click()]);
  await row.getByRole('button', { name: '录入分数' }).waitFor();
  assert.deepEqual((await workspace(page)).state.scores, {});
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'), toolbar.getByRole('button', { name: '导入备份' }).click(),
  ]);
  const restore = page.waitForEvent('dialog').then(dialog => dialog.accept());
  await Promise.all([restore, chooser.setFiles({ name: 'machun1-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) })]);
  await row.getByText(formatScore(score), { exact: true }).waitFor();
  assert.deepEqual(unexpected, []);
  await desktop.close();

  await running.close();
  running = undefined;
  running = await startServer();
  const phone = await browser.newPage({ baseURL: running.origin, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mobile = await openWorkspace(phone, running.origin);
  assert.equal(await phone.getByLabel('导出昵称', { exact: true }).inputValue(), 'SQLite 测试玩家');
  await (await chartRow(phone)).getByText(formatScore(score), { exact: true }).waitFor();
  assert.deepEqual((await workspace(phone)).state.nicknameOverrides, legacy.nicknameOverrides);
  assert.deepEqual(mobile.unexpected, []);
  console.log('PASS: direct desktop and mobile entry, legacy migration, score entry, backup restore, and persistence after local SQLite restart');
} finally {
  try {
    await browser?.close();
  } finally {
    try { await running?.close(); } finally { await rm(dataDirectory, { recursive: true, force: true }); }
  }
}
