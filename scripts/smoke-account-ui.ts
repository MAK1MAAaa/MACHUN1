/** Real Chromium + disposable local MySQL, with fake score portals only. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Browser, type Page, type Request } from 'playwright';
import { eq } from 'drizzle-orm';
import { prepareTestDatabase } from './mysql-test-fixture';
import { AccountService, MysqlSourceStore } from '../server/accountService';
import { createAppServer, type HttpManager } from '../server/http';
import { users, workspaces, bindingTasks } from '../server/db/schema';
import { hashPassword } from '../server/auth';
import { createDatabase } from '../server/db/connection';
import { catalog } from '../src/core/catalog';
import { calculateRating } from '../src/core/rating';
import type { RecordsSort, RecordsSortField } from '../src/core/recordsView';
import { EMPTY_STATE, STORAGE_KEY } from '../src/core/storage';
import { SYNC_SOURCES, type SourceConnection, type SyncResult } from '../src/syncTypes';
import type { ExternalScoreSource } from '../src/core/sources';
import type { LocalState, SingleRating } from '../src/types';
import { SyncError } from '../server/provider';

let fixture = await prepareTestDatabase();
const directory = await mkdtemp(join(tmpdir(), 'machun-account-ui-'));
let service = new AccountService(fixture.db, directory, directory);
const first = catalog[0]; const key = `${first.id}:${first.difficulty}`;
const initialCharts = [...catalog.slice(0, 45), ...catalog.filter(chart => chart.version === 'MATE' && !catalog.slice(0, 45).includes(chart)).slice(0, 5)];
const seed: LocalState = { ...structuredClone(EMPTY_STATE),
  scores: Object.fromEntries(initialCharts.map((chart, index) => [`${chart.id}:${chart.difficulty}`, {
    id: chart.id, title: chart.title, difficulty: chart.difficulty, constant: chart.constant,
    score: 1_000_000 + index, rating: 99, source: index % 2 ? 'rin' : 'munet', updatedAt: '2026-10-08T10:00:00.000Z',
    combo: index === 1 ? undefined : 'fc', clear: index === 1 ? 'absolute' : undefined,
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
async function expandSection(page: Page, title: '全部成绩' | '定数表') {
  const toggle = page.getByRole('button', { name: new RegExp(`^(展开|收起)${title}$`) });
  await toggle.waitFor();
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
}
async function score(page: Page, expected: number, source?: SingleRating['source']) {
  await page.waitForFunction(async ({ key, expected, source }) => {
    const response = await fetch('/api/workspace'); if (!response.ok) return false;
    const current = (await response.json()).state.scores[key]; return current?.score === expected && (!source || current.source === source);
  }, { key, expected, source });
  await expandSection(page, '全部成绩');
  await page.locator('.record-table tbody tr').first().waitFor();
}
async function edit(page: Page, value: number) {
  await expandSection(page, '全部成绩');
  const section = page.locator('.records-browser');
  await section.getByRole('button', { name: '清除筛选', exact: true }).click();
  await section.getByRole('searchbox').fill(first.id);
  const row = page.locator('.record-table tbody tr').filter({ has: page.getByText(first.difficulty, { exact: true }) });
  await row.getByRole('button', { name: '修改分数', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '修改分数', exact: true });
  await dialog.getByLabel('分数', { exact: true }).fill(String(value));
  await dialog.getByRole('button', { name: '保存修改', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await score(page, value, 'manual'); await section.getByRole('searchbox').fill('');
}
async function verifyRecordsSingleSort(page: Page) {
  await expandSection(page, '全部成绩');
  const section = page.locator('.records-browser');
  const labels: Record<RecordsSortField, string> = { score: '分数', rating: 'Rating' };
  const records = Object.values((await state(page)).scores);
  const comparators: Record<RecordsSort, (left: SingleRating, right: SingleRating) => number> = {
    'rating-descending': (left, right) => right.rating - left.rating || right.score - left.score,
    'rating-ascending': (left, right) => left.rating - right.rating || left.score - right.score,
    'score-descending': (left, right) => right.score - left.score || right.rating - left.rating,
    'score-ascending': (left, right) => left.score - right.score || left.rating - right.rating,
  };
  assert.equal(await section.getByLabel('排序方式', { exact: true }).count(), 0);
  assert.equal(await section.getByRole('button', { name: '按定数排序', exact: true }).count(), 0);
  assert.equal(await section.locator('.records-mode, .records-count, .records-sort-help').count(), 0);
  async function check(sort: RecordsSort) {
    const expected = [...records].sort((left, right) => comparators[sort](left, right)
      || right.constant - left.constant || left.title.localeCompare(right.title, 'zh-CN')
      || `${left.id}:${left.difficulty}`.localeCompare(`${right.id}:${right.difficulty}`));
    const displayed = await section.locator('.record-table tbody tr').evaluateAll(rows => rows.map(row => {
      const id = row.querySelector('.record-song-info small')!.textContent!.replace(/^ID /, '');
      const difficulty = row.querySelector('.records-difficulty-cell')!.textContent!;
      return `${id}:${difficulty}`;
    }));
    assert.deepEqual(displayed, expected.slice(0, 10).map(record => `${record.id}:${record.difficulty}`));
    assert.match(await section.locator('.records-page-status').innerText(), /^第 1 \/ /, 'changing the selected sort resets pagination');
    const active = sort.startsWith('score-') ? 'score' : 'rating';
    for (const field of ['score', 'rating'] as const) {
      const button = section.getByRole('button', { name: `按${labels[field]}排序`, exact: true });
      assert.equal(await button.getAttribute('aria-pressed'), String(field === active));
      assert.equal(await button.locator('sup').count(), 0);
    }
    const headers = section.locator('thead th[aria-sort]');
    assert.equal(await headers.count(), 1);
    assert.equal(await headers.getAttribute('aria-sort'), sort.endsWith('ascending') ? 'ascending' : 'descending');
  }
  await check('rating-descending');
  for (const [field, expected] of [
    ['score', 'score-descending'], ['score', 'score-ascending'], ['score', 'score-descending'],
    ['rating', 'rating-descending'], ['rating', 'rating-ascending'], ['rating', 'rating-descending'],
  ] as const) {
    await section.getByRole('button', { name: '下一页', exact: true }).click();
    await section.getByRole('button', { name: `按${labels[field]}排序`, exact: true }).click();
    await check(expected);
  }
}

async function exportPng(page: Page, name: string) {
  const isAj = name === '导出 AJ B30 图片';
  const isB50 = name === '导出 B50 图片';
  const withCandidates = name.includes('候选20');
  const imageLabel = isB50 ? 'B50' : isAj ? 'AJ B30' : withCandidates ? 'B30 + 候选20' : 'B30';
  const filePrefix = isB50 ? 'b50' : isAj ? 'aj-b30' : `b30${withCandidates ? '-candidates20' : ''}`;
  let downloads = 0;
  const countDownload = () => { downloads++; };
  page.on('download', countDownload);
  try {
    await page.getByRole('button', { name, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `${imageLabel} 图片预览`, exact: true });
    await dialog.waitFor();
    const image = dialog.locator('img');
    await image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth
      ? undefined : new Promise<void>((resolve, reject) => { element.onload = () => resolve(); element.onerror = () => reject(new Error('export preview failed')); }));
    assert.equal(await image.evaluate((element: HTMLImageElement) => element.naturalWidth), 2360);
    assert.equal(downloads, 0, 'generating the preview must not start an asynchronous download');
    const downloadPromise = page.waitForEvent('download');
    await dialog.getByRole('button', { name: '保存 PNG', exact: true }).click();
    const download = await downloadPromise; const file = await download.path(); assert(file);
    assert.match(download.suggestedFilename(), new RegExp(`^machun1-${filePrefix}-\\d{4}-\\d{2}-\\d{2}\\.png$`));
    const png = await readFile(file); assert.equal(png.readUInt32BE(16), 2360);
    assert.equal(png.readUInt32BE(20), isB50 ? 2268 : withCandidates ? 2224 : 1360);
    assert.equal(downloads, 1);
    assert(await dialog.isVisible(), 'preview remains available for a retry or long-press saving');
    assert((await dialog.getByRole('status').innerText()).includes('已发起保存'));
    assert.equal(await dialog.getByRole('link', { name: '打开原图', exact: true }).getAttribute('target'), '_blank');
    await download.saveAs(join(output, `${page.viewportSize()?.width}-${download.suggestedFilename()}`));
    await dialog.getByRole('button', { name: '关闭图片预览', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  } finally { page.off('download', countDownload); }
}

async function exportConstantTable(page: Page, withScores: boolean) {
  await expandSection(page, '定数表');
  const section = page.locator('.constant-table-section');
  const showScores = section.getByRole('button', { name: '显示成绩', exact: true });
  if ((await showScores.getAttribute('aria-pressed') === 'true') !== withScores) await showScores.click();
  await section.getByRole('button', { name: '导出定数表 PNG', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '定数表 图片预览', exact: true });
  await dialog.waitFor();
  const image = dialog.locator('img');
  await image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth ? undefined
    : new Promise<void>((resolve, reject) => { element.onload = () => resolve(); element.onerror = () => reject(new Error('constant table preview failed')); }));
  const downloadEvent = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '保存 PNG', exact: true }).click();
  const download = await downloadEvent; const file = await download.path(); assert(file);
  assert.match(download.suggestedFilename(), withScores ? /^machun1-constant-table-scores-\d{4}-\d{2}-\d{2}\.png$/ : /^machun1-constant-table-\d{4}-\d{2}-\d{2}\.png$/);
  const png = await readFile(file);
  assert(png.readUInt32BE(16) > 0 && png.readUInt32BE(16) <= 2000);
  assert(png.readUInt32BE(20) > 164 && png.readUInt32BE(20) <= 16000);
  await download.saveAs(join(output, `${page.viewportSize()?.width}-${download.suggestedFilename()}`));
  await dialog.getByRole('button', { name: '关闭图片预览', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

async function verifyAvailableConstantFilters(page: Page) {
  await expandSection(page, '全部成绩');
  const section = page.locator('.records-browser');
  const constant = section.getByLabel('定数', { exact: true });
  await section.getByRole('button', { name: '清除筛选', exact: true }).click();
  await section.getByLabel('难度', { exact: true }).selectOption('ULT');
  await section.getByLabel('等级', { exact: true }).selectOption('15+');
  assert.deepEqual(await constant.locator('option').allTextContents(), ['全部定数', '15.8']);
  await constant.selectOption('15.8');
  await section.getByLabel('难度', { exact: true }).selectOption('MAS');
  assert.deepEqual(await constant.locator('option').allTextContents(), ['全部定数', '15.5', '15.6', '15.7']);
  assert.equal(await constant.inputValue(), '', 'switching difficulty clears an unavailable constant');
  await constant.selectOption('15.7');
  await section.getByLabel('难度', { exact: true }).selectOption('EXP');
  assert.deepEqual(await constant.locator('option').allTextContents(), ['全部定数']);
  assert.equal(await constant.inputValue(), '');
  await section.getByRole('button', { name: '清除筛选', exact: true }).click();
}

async function verifyConstantTableMissingStep(page: Page) {
  await expandSection(page, '定数表');
  const section = page.locator('.constant-table-section');
  const constant = section.getByLabel('定数表定数', { exact: true });
  const generate = section.getByRole('button', { name: '生成定数表', exact: true });
  const exportButton = section.getByRole('button', { name: '导出定数表 PNG', exact: true });
  const generatedConstants = () => section.locator('.constant-table-group').evaluateAll(elements => elements.map(element => element.getAttribute('data-constant')));
  assert.equal(await constant.getAttribute('multiple'), null);
  assert.equal(await constant.locator('option[value=""]').innerText(), '选择定数');
  assert.equal(await section.locator('fieldset, .constant-table-result-count, .constant-table-pending').count(), 0);
  await section.getByLabel('定数表难度', { exact: true }).selectOption('ULT');
  assert.equal(await constant.locator('option[value="15.9"]').count(), 0);
  assert.equal(await constant.locator('option[value="15.8"]').count(), 1);
  assert.equal(await constant.locator('option[value="16.0"]').count(), 1);
  await constant.selectOption('15.8');
  await generate.click();
  assert.deepEqual(await generatedConstants(), ['15.8']);
  await exportConstantTable(page, false);
  await constant.selectOption('16.0');
  assert.equal(await constant.inputValue(), '16.0');
  assert.deepEqual(await generatedConstants(), ['15.8'], 'changing the selected constant retains the previous generated table');
  assert(await exportButton.isDisabled(), 'a changed selection cannot export stale results');
  await generate.click();
  assert.deepEqual(await generatedConstants(), ['16.0']);
  await constant.selectOption('');
  assert(await generate.isDisabled());
  assert(await exportButton.isDisabled());
  assert.deepEqual(await generatedConstants(), ['16.0']);
  await constant.selectOption('16.0');
  await section.getByLabel('定数表难度', { exact: true }).selectOption('EXP');
  assert.equal(await constant.inputValue(), '', 'changing difficulty clears an unavailable selected constant');
  assert.equal(await constant.locator('option[value="16.0"]').count(), 0);
  assert(await generate.isDisabled());
  await section.getByLabel('定数表难度', { exact: true }).selectOption('');
  await constant.selectOption('14.0');
  await generate.click();
  assert.deepEqual(await generatedConstants(), ['14.0']);
}

async function verifyConstantTableLevelAll(page: Page) {
  await expandSection(page, '定数表');
  const section = page.locator('.constant-table-section');
  const level = section.getByLabel('定数表等级', { exact: true });
  const constant = section.getByLabel('定数表定数', { exact: true });
  const allConstants = constant.locator('option[value="all"]');
  const generate = section.getByRole('button', { name: '生成定数表', exact: true });
  const exportButton = section.getByRole('button', { name: '导出定数表 PNG', exact: true });
  const generatedConstants = () => section.locator('.constant-table-group').evaluateAll(elements => elements.map(element => element.getAttribute('data-constant')));
  const before = await state(page), mutations: string[] = [];
  const recordMutation = (request: Request) => {
    if (new URL(request.url()).pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method())) mutations.push(request.method());
  };
  page.on('request', recordMutation);
  try {
    assert.equal(await level.inputValue(), '');
    assert.notEqual(await allConstants.getAttribute('disabled'), null, 'all constants are disabled without one selected level');
    await level.selectOption('14');
    assert.equal(await allConstants.getAttribute('disabled'), null);
    await constant.selectOption('all');
    assert.equal(await constant.inputValue(), 'all');
    assert(await exportButton.isDisabled(), 'all-constant selection cannot export the prior generated table');
    assert.deepEqual(await generatedConstants(), ['14.0']);
    await generate.click();
    const expected = ['14.4', '14.3', '14.2', '14.1', '14.0'];
    assert.deepEqual(await generatedConstants(), expected);
    await section.getByRole('button', { name: '收起定数表', exact: true }).click();
    assert.equal(await level.isVisible(), false);
    await expandSection(page, '定数表');
    assert.equal(await constant.inputValue(), 'all');
    assert.deepEqual(await generatedConstants(), expected, 'folding preserves the selection and generated groups');
    await level.selectOption('');
    assert.notEqual(await allConstants.getAttribute('disabled'), null);
    assert.equal(await constant.inputValue(), '', 'returning to all levels clears the all-constant selection');
    assert(await generate.isDisabled());
    assert(await exportButton.isDisabled());
    assert.deepEqual(await generatedConstants(), expected);
    await constant.selectOption('14.0');
    await generate.click();
    assert.deepEqual(await generatedConstants(), ['14.0']);
    assert.deepEqual(await state(page), before, 'constant selection, generation and folding do not alter the account workspace');
    assert.deepEqual(mutations, [], 'constant table controls make no API writes');
  } finally { page.off('request', recordMutation); }
  mark('one selected level enables all its constants, generates five level-14 groups, retains them while folded and disables all-selection across all levels without API writes');
}

async function verifyConstantTable(page: Page) {
  await expandSection(page, '定数表');
  const section = page.locator('.constant-table-section');
  const constant = section.getByLabel('定数表定数', { exact: true });
  const generate = section.getByRole('button', { name: '生成定数表', exact: true });
  const exportButton = section.getByRole('button', { name: '导出定数表 PNG', exact: true });
  assert.equal(await section.locator('.constant-table-score-panel').count(), 0);
  assert.equal(await section.locator('.constant-table-grid').first().evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length), 10);
  await verifyConstantTableMissingStep(page);
  await verifyConstantTableLevelAll(page);
  await constant.selectOption('');
  assert(await generate.isDisabled());
  await constant.selectOption('13.0');
  await constant.selectOption('13.4');
  assert.equal(await constant.inputValue(), '13.4');
  assert.deepEqual(await constant.locator('option:checked').allTextContents(), ['13.4']);
  assert.deepEqual(await section.locator('.constant-table-group').evaluateAll(elements => elements.map(element => element.getAttribute('data-constant'))), ['14.0']);
  assert(await exportButton.isDisabled(), 'changed filters must not export an old result');
  await generate.click();
  assert.deepEqual(await section.locator('.constant-table-group').evaluateAll(elements => elements.map(element => element.getAttribute('data-constant'))), ['13.4']);
  const groups = await section.locator('.constant-table-group').evaluateAll(elements => elements.map(element => [...element.querySelectorAll('li[data-chart-key]')].map(entry => ({
    difficulty: entry.getAttribute('data-difficulty')!, date: entry.getAttribute('data-release-date')!,
  }))));
  const difficultyOrder: Record<string, number> = { ULT: 0, MAS: 1, EXP: 2 };
  for (const entries of groups) for (let index = 1; index < entries.length; index++) {
    const previous = entries[index - 1], current = entries[index];
    assert(difficultyOrder[previous.difficulty] <= difficultyOrder[current.difficulty]);
    if (previous.difficulty === current.difficulty) assert((previous.date || '9999').localeCompare(current.date || '9999') <= 0);
  }
  const target = catalog.find(chart => chart.difficulty === 'MAS' && chart.constant >= 13.5 && chart.constant <= 13.9)!;
  assert(target);
  await section.getByLabel('定数表等级', { exact: true }).selectOption('13+');
  assert.deepEqual(await constant.locator('option:not([value="all"])').allTextContents(), ['选择定数', '13.5', '13.6', '13.7', '13.8', '13.9']);
  assert.equal(await constant.inputValue(), '', 'changing level clears the previous 13.4 selection');
  await section.getByLabel('定数表难度', { exact: true }).selectOption('MAS');
  await section.getByLabel('定数表分类', { exact: true }).selectOption(target.genre);
  await section.getByLabel('定数表版本', { exact: true }).selectOption(target.version);
  await constant.selectOption(target.constant.toFixed(1));
  await generate.click();
  const filteredKeys = await section.locator('li[data-chart-key]').evaluateAll(elements => elements.map(element => element.getAttribute('data-chart-key')));
  assert(filteredKeys.includes(`${target.id}:${target.difficulty}`));
  for (const key of filteredKeys) {
    const data = catalog.find(chart => `${chart.id}:${chart.difficulty}` === key)!;
    assert(data.difficulty === 'MAS' && data.constant === target.constant && data.genre === target.genre && data.version === target.version);
  }
  for (const label of ['定数表等级', '定数表难度', '定数表分类', '定数表版本']) await section.getByLabel(label, { exact: true }).selectOption('');
  await constant.selectOption(first.constant.toFixed(1));
  await generate.click();
  await exportConstantTable(page, false);
  await section.getByRole('button', { name: '显示成绩', exact: true }).click();
  assert.equal(await section.locator('.constant-table-grid').first().evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length), 5);
  const card = section.locator(`li[data-chart-key="${key}"]`);
  const current = (await state(page)).scores[key];
  assert.equal((await card.locator('.constant-table-score').innerText()).replaceAll(',', ''), String(current.score));
  assert.equal(await card.locator('.constant-table-lamp').innerText(), current.combo ? { fc: 'FULL COMBO', aj: 'ALL JUSTICE', ajc: 'AJC' }[current.combo] : 'CLEAR');
  assert(await section.locator('.constant-table-lamp').evaluateAll(elements => elements.every(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const text = range.getBoundingClientRect(), panel = element.parentElement!.getBoundingClientRect();
    return text.left >= panel.left - 1 && text.right <= panel.right + 1;
  })), 'full achievement labels fit the desktop score panel');
  const box = await card.boundingBox(); assert(box && Math.abs(box.width - box.height * 2) < 2);
  await exportConstantTable(page, true);
  mark('constant tables select one available constant, clear invalid selections, retain old results until generation, render 10/5 columns and save both PNG modes');
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
  for (const title of ['全部成绩', '定数表']) assert.equal(await page.getByRole('button', { name: `展开${title}`, exact: true }).getAttribute('aria-expanded'), 'false');
  assert.equal(Object.keys((await state(page)).scores).length, 50);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY), JSON.stringify(seed));
  assert.equal(await page.locator('.record-table tbody tr').count(), 10);
  mark('root login migrates 50 legacy scores and one alias while keeping the old browser copy');
  const exportNickname = '分表测试玩家';
  await page.getByLabel('导出昵称', { exact: true }).fill(exportNickname);
  await page.locator('.b30-export-settings').getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForFunction(async nickname => {
    const response = await fetch('/api/workspace');
    return response.ok && (await response.json()).exportNickname === nickname;
  }, exportNickname);
  await page.reload(); await page.locator('.account-toolbar').waitFor();
  assert.equal(await page.getByLabel('导出昵称', { exact: true }).inputValue(), exportNickname);
  assert(await page.locator('.b30-export-settings').getByRole('button', { name: '保存', exact: true }).isDisabled());
  mark('export nickname is saved to the account and survives a full page reload');
  let emptyAjDownloads = 0;
  const countEmptyAjDownload = () => { emptyAjDownloads++; };
  page.on('download', countEmptyAjDownload);
  try {
    await page.getByRole('button', { name: '导出 AJ B30 图片', exact: true }).click();
    await page.getByText('暂无 AJ 或 AJC 成绩，无法生成 AJ B30 图片。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(emptyAjDownloads, 0);
  } finally { page.off('download', countEmptyAjDownload); }
  mark('scores without AJ cannot generate an AJ B30 preview or download');
  assert.equal(await page.locator('.b30-preview-toggle, #b30-image-preview, .b30-grid, .b30-card').count(), 0);
  assert.equal(await page.locator('.b30-analysis').count(), 1);
  await edit(page, 1_001_000);
  await page.reload(); await page.locator('.account-toolbar').waitFor(); await score(page, 1_001_000, 'manual');
  mark('manual score, achievements and source survive refresh; legacy migration does not repeat');
  const section = page.locator('.records-browser');
  await verifyAvailableConstantFilters(page);
  await page.getByLabel('等级', { exact: true }).selectOption('13');
  assert.deepEqual(await page.getByLabel('定数', { exact: true }).locator('option').allTextContents(), ['全部定数', '13.0', '13.1', '13.2', '13.3', '13.4']);
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await verifyRecordsSingleSort(page);
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  mark('desktop score and Rating headers select one sort, toggle direction, apply the other value as a tie-breaker and reset pagination');
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
  await section.getByRole('searchbox').fill(''); await section.getByRole('button', { name: '清除筛选', exact: true }).click();
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
  const accountTools = page.locator('.account-data-toolbar');
  assert.deepEqual(await accountTools.getByRole('button').allTextContents(), ['导入备份', '导出备份', '清除数据']);
  assert.equal(await accountTools.locator('select, p, small, dl').count(), 0);
  assert.equal(await page.locator('.local-tools-toggle').count(), 0);
  const backupDownload = page.waitForEvent('download');
  await accountTools.getByRole('button', { name: '导出备份', exact: true }).click();
  const backup = await backupDownload; const path = await backup.path(); assert(path);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.scores.length, 50);
  assert(saved.scores.some((row: SingleRating) => row.combo === 'aj' && row.fullChain === 'platinum'));
  assert(saved.scores.some((row: SingleRating) => row.clear === 'absolute' && !row.combo));
  assert.equal(saved.nicknameOverrides['3055'][0], '个人测试别名');
  assert(!JSON.stringify(saved).includes('token'));
  await edit(page, 1_007_000);
  const chooserPromise = page.waitForEvent('filechooser');
  await accountTools.getByRole('button', { name: '导入备份', exact: true }).click();
  const chooser = await chooserPromise;
  const importRequest = page.waitForRequest(request => request.method() === 'POST'
    && new URL(request.url()).pathname === '/api/workspace/actions'
    && request.postDataJSON().type === 'backup');
  page.once('dialog', async dialog => {
    assert.equal(dialog.type(), 'confirm');
    assert.match(dialog.message(), /替换当前账号的全部成绩和个人别名/);
    await dialog.accept();
  });
  await chooser.setFiles({ name: 'full-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(saved)) });
  assert.equal((await importRequest).postDataJSON().mode, 'replace');
  await score(page, 1_006_000, 'rin');
  assert.equal(Object.keys((await state(page)).scores).length, saved.scores.length);
  assert.deepEqual((await state(page)).nicknameOverrides, saved.nicknameOverrides);
  mark('permanent three-action account toolbar imports backups in replace mode, restoring lower saved scores, aliases, source and AJ/full-chain marks');
  assert.equal(await page.getByLabel('导出昵称', { exact: true }).inputValue(), exportNickname);
  for (const name of ['导出 B30 图片', '导出 B30 + 候选20 图片', '导出 AJ B30 图片', '导出 B50 图片']) {
    await exportPng(page, name);
  }
  mark('full JSON backup and regular, AJ B30 and OLD 30 / NEW 20 B50 PNGs retain source, FC/AJ and grades');
  await verifyConstantTable(page);
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
  assert.equal(await page.getByLabel('导出昵称', { exact: true }).inputValue(), '');
  assert.equal(await page.getByLabel('导出昵称', { exact: true }).getAttribute('placeholder'), 'ui-second');
  assert.equal(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY), JSON.stringify(seed));
  await page.locator('.source-tools-toggle').click();
  assert.equal(await page.locator('.source-connection-status').filter({ hasText: /^未绑定$/ }).count(), 4);
  mark('logout revokes the session; the next user sees no root scores, aliases or bindings, even after a delayed sync');
  const secondContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await secondContext.route('https://otoge-db.net/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: cover }));
  const mobile = await secondContext.newPage(); mobile.setDefaultTimeout(15_000);
  await mobile.goto(origin); await login(mobile, 'root', 'pwd');
  for (const title of ['全部成绩', '定数表']) assert.equal(await mobile.getByRole('button', { name: `展开${title}`, exact: true }).getAttribute('aria-expanded'), 'false');
  assert.equal(Object.keys((await state(mobile)).scores).length, 50);
  assert.equal((await state(mobile)).nicknameOverrides['3055'][0], '个人测试别名');
  assert.equal(await mobile.evaluate(key => localStorage.getItem(key), STORAGE_KEY), null);
  const mobileAccountTools = mobile.locator('.account-data-toolbar');
  assert.deepEqual(await mobileAccountTools.getByRole('button').allTextContents(), ['导入备份', '导出备份', '清除数据']);
  await expandSection(mobile, '全部成绩');
  for (const width of [320, 390, 768]) {
    await mobile.setViewportSize({ width, height: 844 });
    assert(await mobileAccountTools.evaluate(element => element.scrollWidth <= element.clientWidth));
    assert.equal(await mobile.locator('.b30-preview-toggle, #b30-image-preview, .b30-grid, .b30-card').count(), 0);
    assert.equal(await mobile.locator('.b30-analysis').count(), 1);
    assert(await mobile.locator('.record-table').evaluate(element => element.scrollWidth <= element.clientWidth));
    assert.equal(await mobile.locator('.record-table tbody tr').first().evaluate(element => getComputedStyle(element).display), 'grid');
  }
  await mobile.setViewportSize({ width: 390, height: 844 });
  assert.equal(await mobile.getByLabel('导出昵称', { exact: true }).inputValue(), exportNickname);
  mark('a second user cannot read the nickname, while the same account on a fresh mobile context restores it from MySQL');
  const mobileConstants = mobile.locator('.constant-table-section');
  await expandSection(mobile, '定数表');
  for (const width of [320, 390, 768]) {
    await mobile.setViewportSize({ width, height: 844 });
    assert(await mobileConstants.evaluate(element => element.scrollWidth <= element.clientWidth));
  }
  await mobile.setViewportSize({ width: 390, height: 844 });
  await verifyConstantTableMissingStep(mobile);
  await verifyConstantTableLevelAll(mobile);
  await exportConstantTable(mobile, false);
  await exportConstantTable(mobile, true);
  assert.equal(await mobileConstants.locator('.constant-table-grid').first().evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length), 1);
  for (const width of [320, 390, 768]) {
    await mobile.setViewportSize({ width, height: 844 });
    assert(await mobileConstants.locator('.constant-table-lamp').evaluateAll(elements => elements.every(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      const text = range.getBoundingClientRect(), panel = element.parentElement!.getBoundingClientRect();
      return text.left >= panel.left - 1 && text.right <= panel.right + 1;
    })), `full achievement labels fit the ${width}px score panel`);
  }
  await mobile.setViewportSize({ width: 390, height: 844 });
  mark('touch constant tables avoid horizontal overflow and both cover and score PNGs save after an explicit tap');
  const mobileRecords = mobile.locator('.records-browser');
  assert.equal(await mobileRecords.getByLabel('等级', { exact: true }).isVisible(), false);
  await mobileRecords.getByRole('button', { name: '展开筛选', exact: true }).click();
  await verifyAvailableConstantFilters(mobile);
  await mobileRecords.getByLabel('等级', { exact: true }).selectOption('13');
  assert.deepEqual(await mobileRecords.getByLabel('定数', { exact: true }).locator('option').allTextContents(), ['全部定数', '13.0', '13.1', '13.2', '13.3', '13.4']);
  await mobileRecords.getByRole('button', { name: '清除筛选', exact: true }).click();
  await mobileRecords.getByRole('button', { name: '收起筛选', exact: true }).click();
  await verifyRecordsSingleSort(mobile);
  await mobileRecords.getByRole('button', { name: '展开筛选', exact: true }).click();
  await mobileRecords.getByRole('button', { name: '清除筛选', exact: true }).click();
  mark('touch sorting buttons stay available with filters collapsed and select only score or Rating with the same tie-breakers as desktop');
  await mobileRecords.getByRole('button', { name: '收起筛选', exact: true }).click();
  for (const name of ['导出 B30 图片', '导出 B30 + 候选20 图片', '导出 AJ B30 图片', '导出 B50 图片']) await exportPng(mobile, name);
  mark('touch viewport omits the B30 card preview while keeping the chart, readable records and collapsed filters; regular, AJ B30 and B50 PNGs save after an explicit tap without reporting unconfirmed success');
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
  await mobile.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); });
  await mobileCard.getByRole('button', { name: '复制命令', exact: true }).click();
  await mobileCard.locator('.companion-binding').getByRole('status').filter({ hasText: /^已复制$/ }).waitFor();
  await mobileCard.getByRole('button', { name: '复制绑定码', exact: true }).click();
  await mobileCard.locator('.companion-binding').getByRole('status').filter({ hasText: /^已复制$/ }).waitFor();
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
