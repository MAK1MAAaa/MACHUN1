/** Run with: pnpm exec tsx scripts/smoke-ui.ts (after pnpm build).
 * Uses an isolated Chrome context and an in-memory fake backend; no real logins or profiles.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Download, type Page } from "playwright";
import { createAppServer, type HttpManager } from "../server/http";
import { SyncError } from "../server/provider";
import { catalog } from "../src/core/catalog";
import { getB30Axis } from "../src/core/b30";
import { calculateRating } from "../src/core/rating";
import { getChartLevel } from "../src/core/recordsView";
import { STORAGE_KEY } from "../src/core/storage";
import { SYNC_SOURCES, type SourceConnection, type SyncResult } from "../src/syncTypes";
import type { ExternalScoreSource } from "../src/core/sources";
import type { CatalogChart, LocalState, SingleRating } from "../src/types";

interface ClipboardFixture {
  mode: "success" | "denied" | "missing";
  calls: string[];
  fallbackCalls: string[];
}

declare global {
  interface Window {
    __smokeClipboard: ClipboardFixture;
  }
}

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const firstChart = catalog[0];
const firstKey = `${firstChart.id}:${firstChart.difficulty}`;
const fakeToken = "ui-smoke-fake-token-not-a-real-credential";
const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1cAAAAASUVORK5CYII=", "base64");

function record(score: number, source: SingleRating["source"]): SingleRating {
  return chartRecord(firstChart, score, source);
}

function chartRecord(chart: CatalogChart, score: number, source: SingleRating["source"]): SingleRating {
  return {
    id: chart.id, title: chart.title, difficulty: chart.difficulty,
    constant: chart.constant, rating: calculateRating(score, chart.constant),
    score, source, updatedAt: "2026-10-04T10:00:00.000Z",
  };
}

const fixtureSources: SingleRating["source"][] = ["manual", "rin", "otogame", "lxns", "munet", "munet", "munet"];
const seed: LocalState = {
  schemaVersion: 2,
  scores: Object.fromEntries(catalog.slice(0, 50).map((chart, index) => [
    `${chart.id}:${chart.difficulty}`, chartRecord(chart, 1_000_000 + index, fixtureSources[index % fixtureSources.length]),
  ])),
  nicknameOverrides: { [firstChart.id]: ["冒烟测试别名"] },
};

class FakeManager implements HttpManager {
  readonly state = new Map<ExternalScoreSource, SourceConnection>(SYNC_SOURCES.map((source) => [source, {
    source, status: "unbound", bound: false, identity: null, lastAttemptAt: null, lastSuccessAt: null, error: null,
  }]));
  readonly bindingCalls = new Map<ExternalScoreSource, number>();
  readonly syncCalls = new Map<ExternalScoreSource, number>();
  readonly scores = new Map<ExternalScoreSource, number>(SYNC_SOURCES.map((source, index) => [source, 1_002_000 + index]));
  readonly batches = new Map<ExternalScoreSource, SingleRating[]>();
  listCalls = 0;
  receivedToken: string | undefined;
  private holdSource: ExternalScoreSource | undefined;
  private releaseHeld: (() => void) | undefined;

  connections(): SourceConnection[] {
    this.listCalls += 1;
    return structuredClone([...this.state.values()]);
  }

  async bind(source: ExternalScoreSource, token?: string): Promise<SourceConnection> {
    this.bindingCalls.set(source, (this.bindingCalls.get(source) ?? 0) + 1);
    const current = this.state.get(source)!;
    Object.assign(current, { status: "binding", error: null });
    if (source === "lxns") {
      assert.equal(token, fakeToken);
      this.receivedToken = token;
      this.completeBinding(source);
    }
    return structuredClone(current);
  }

  completeBinding(source: ExternalScoreSource): void {
    const current = this.state.get(source)!;
    assert.equal(current.status, "binding");
    Object.assign(current, {
      status: "ready", bound: true,
      identity: { id: `fake-${source}`, label: `${source} 测试玩家`, ...(source === "rin" || source === "otogame" ? { cardId: "10001" } : {}) },
    });
  }

  async unbind(source: ExternalScoreSource): Promise<SourceConnection> {
    const current = this.state.get(source)!;
    Object.assign(current, { status: "unbound", bound: false, identity: null, error: null, lastAttemptAt: null, lastSuccessAt: null });
    return structuredClone(current);
  }

  holdNextSync(source: ExternalScoreSource, score: number): void {
    this.holdSource = source;
    this.scores.set(source, score);
  }

  releaseSync(): void {
    this.releaseHeld?.();
    this.releaseHeld = undefined;
  }

  async sync(source: ExternalScoreSource): Promise<SyncResult> {
    const current = this.state.get(source)!;
    if (!current.bound) throw new SyncError("NOT_BOUND", "请先绑定该来源。", 409);
    this.syncCalls.set(source, (this.syncCalls.get(source) ?? 0) + 1);
    Object.assign(current, { status: "syncing", lastAttemptAt: new Date().toISOString() });
    if (this.holdSource === source) {
      this.holdSource = undefined;
      await new Promise<void>((resolveHeld) => { this.releaseHeld = resolveHeld; });
    }
    Object.assign(current, { status: "ready", lastSuccessAt: new Date().toISOString() });
    const records = this.batches.get(source) ?? [record(this.scores.get(source)!, source)];
    return {
      source, records: structuredClone(records), connection: structuredClone(current),
      report: { parsedScores: records.length, importedScores: records.length, updatedScores: 0, skippedScores: 0, unknownCharts: 0, invalidEntries: 0 },
    };
  }
}

async function readState(page: Page): Promise<LocalState> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), STORAGE_KEY);
}

async function waitForScore(page: Page, score: number, source?: SingleRating["source"]): Promise<void> {
  await page.waitForFunction(({ storageKey, key, expectedScore, expectedSource }) => {
    const state = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    return state?.scores[key]?.score === expectedScore && (!expectedSource || state.scores[key].source === expectedSource);
  }, { storageKey: STORAGE_KEY, key: firstKey, expectedScore: score, expectedSource: source });
}

async function editScore(page: Page, score: number, chart: CatalogChart = firstChart): Promise<void> {
  const section = page.locator(".records-browser");
  await section.getByRole("button", { name: "Rating 排名", exact: true }).click();
  await section.getByRole("searchbox").fill(chart.id);
  const row = page.locator(".record-table tbody tr")
    .filter({ has: page.getByText(`ID ${chart.id}`, { exact: true }) })
    .filter({ has: page.getByText(chart.difficulty, { exact: true }) });
  await row.getByRole("button", { name: "修改分数", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "修改分数", exact: true });
  await dialog.getByLabel("分数", { exact: true }).fill(String(score));
  await dialog.getByRole("button", { name: "保存修改", exact: true }).click();
  await page.waitForFunction(({ storageKey, key, expectedScore }) => {
    const state = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    return state?.scores[key]?.score === expectedScore && state.scores[key].source === "manual";
  }, { storageKey: STORAGE_KEY, key: `${chart.id}:${chart.difficulty}`, expectedScore: score });
  await section.getByRole("searchbox").fill("");
}

async function checkNationalRepair(page: Page, manager: FakeManager, outputDirectory: string, mark: (message: string) => void): Promise<void> {
  const repairFixture = structuredClone(seed);
  const previous: [number, SingleRating["source"]][] = [
    [1_007_000, "munet"], [1_004_000, "munet"], [1_003_000, "munet"],
    [1_008_000, "rin"], [1_008_000, "manual"], [1_008_000, "munet"], [1_008_000, "lxns"],
  ];
  previous.forEach(([score, source], index) => {
    const chart = catalog[index];
    repairFixture.scores[`${chart.id}:${chart.difficulty}`] = chartRecord(chart, score, source);
  });
  const nationalRecords = [1_003_000, 1_004_000, 1_005_000, 1_001_000, 1_001_000, undefined, 1_001_000]
    .flatMap((score, index) => score === undefined ? [] : [chartRecord(catalog[index], score, "lxns")]);
  const normalExpected = structuredClone(repairFixture);
  const repairedExpected = structuredClone(repairFixture);
  for (const incoming of nationalRecords) {
    const key = `${incoming.id}:${incoming.difficulty}`;
    if (incoming.score > normalExpected.scores[key].score) normalExpected.scores[key] = incoming;
    if (repairedExpected.scores[key].source === "munet") repairedExpected.scores[key] = incoming;
  }
  const card = page.locator(".source-card.lxns");
  const repairToggle = card.getByRole("button", { name: "国服覆盖 MuNET", exact: true });
  const resetFixture = async () => {
    await page.evaluate(({ key, state }) => localStorage.setItem(key, JSON.stringify(state)), { key: STORAGE_KEY, state: repairFixture });
    await page.reload({ waitUntil: "networkidle" });
    await page.locator(".source-tools-toggle").click();
    assert.equal(await repairToggle.getAttribute("aria-pressed"), "false");
  };
  const assertState = async (expected: LocalState) => {
    await page.waitForFunction(({ key, state }) => {
      const current = JSON.parse(localStorage.getItem(key) ?? "null");
      return current && Object.keys(current.scores).length === Object.keys(state.scores).length
        && Object.entries(state.scores).every(([scoreKey, item]) => current.scores[scoreKey]?.score === item.score && current.scores[scoreKey]?.source === item.source);
    }, { key: STORAGE_KEY, state: expected });
    assert.deepEqual(await readState(page), expected);
  };
  const selectFile = async (name: string, buffer: Buffer, changeModeAfterSelection = false) => {
    const chooserPromise = page.waitForEvent("filechooser");
    await card.getByRole("button", { name: "选择落雪 CSV / JSON", exact: true }).click();
    const chooser = await chooserPromise;
    if (changeModeAfterSelection) await repairToggle.click();
    await chooser.setFiles({ name, mimeType: name.endsWith(".csv") ? "text/csv" : "application/json", buffer });
  };
  const levelIndex = { EXP: 2, MAS: 3, ULT: 4 };
  const jsonFile = Buffer.from(JSON.stringify({ success: true, data: nationalRecords.map((item) => ({
    id: item.id, level_index: levelIndex[item.difficulty], score: item.score, upload_time: item.updatedAt,
  })) }));
  const csvFile = Buffer.from(["id,level_index,score,upload_time", ...nationalRecords.map((item) =>
    `${item.id},${levelIndex[item.difficulty]},${item.score},${item.updatedAt}`)].join("\n"));

  await resetFixture();
  await selectFile("national-normal.json", jsonFile);
  await assertState(normalExpected);
  mark("ordinary national file import preserves lower/equal MuNET scores and merges only higher scores");

  await resetFixture();
  await repairToggle.click();
  assert.equal(await repairToggle.getAttribute("aria-pressed"), "true");
  assert((await card.locator(".source-repair-controls").innerText()).includes("同分和较低分也会覆盖"));
  await card.screenshot({ path: join(outputDirectory, "desktop-national-repair.png") });
  await selectFile("national-repair.csv", csvFile, true);
  assert.equal(await repairToggle.getAttribute("aria-pressed"), "false");
  await assertState(repairedExpected);
  assert((await page.locator(".toast.success").innerText()).includes("其中覆盖 MuNET 3 条"));
  mark("CSV repair captures the selected mode and corrects lower/equal/higher MuNET records while preserving other sources, unmatched records and aliases");

  await resetFixture();
  await repairToggle.click();
  await selectFile("national-repair.json", jsonFile);
  await assertState(repairedExpected);
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".source-tools-toggle").click();
  assert.equal(await repairToggle.getAttribute("aria-pressed"), "false");
  await assertState(repairedExpected);
  mark("JSON repair uses the same correction behavior and refresh retains corrected scores with the mode switched off");

  await resetFixture();
  manager.batches.set("lxns", nationalRecords);
  await card.getByRole("button", { name: "同步成绩", exact: true }).click();
  await card.locator(".source-connection-status").filter({ hasText: /^已绑定$/ }).waitFor();
  await assertState(normalExpected);
  mark("ordinary national sync continues to merge only higher scores when the correction mode is off");

  await resetFixture();
  await repairToggle.click();
  manager.holdNextSync("lxns", 1_003_000);
  await card.getByRole("button", { name: "同步成绩", exact: true }).click();
  await card.locator(".source-connection-status").filter({ hasText: /^正在同步$/ }).waitFor();
  assert(await repairToggle.isDisabled());
  await editScore(page, 1_009_500, catalog[3]);
  manager.releaseSync();
  const latestExpected = structuredClone(repairedExpected);
  latestExpected.scores[`${catalog[3].id}:${catalog[3].difficulty}`] = chartRecord(catalog[3], 1_009_500, "manual");
  // Manual edits use the current clock rather than the fixed file fixture time.
  await page.waitForFunction(({ key, scoreKey }) => {
    const state = JSON.parse(localStorage.getItem(key) ?? "null");
    return state?.scores[scoreKey]?.score === 1_003_000 && state.scores[scoreKey].source === "lxns";
  }, { key: STORAGE_KEY, scoreKey: firstKey });
  latestExpected.scores[`${catalog[3].id}:${catalog[3].difficulty}`].updatedAt = (await readState(page)).scores[`${catalog[3].id}:${catalog[3].difficulty}`].updatedAt;
  await assertState(latestExpected);
  assert(await repairToggle.isEnabled());
  await page.setViewportSize({ width: 390, height: 844 });
  await card.screenshot({ path: join(outputDirectory, "mobile-national-repair.png") });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "national correction controls must not overflow mobile viewport");
  await page.setViewportSize({ width: 1440, height: 1000 });
  manager.batches.delete("lxns");
  mark("national sync repair disables mode changes during a request and merges against the latest manual edits without mobile overflow");
}

async function checkTableSourceAndScoreControls(page: Page, mark: (message: string) => void): Promise<void> {
  const section = page.locator(".records-browser");
  const rows = section.locator(".record-table tbody tr");
  const header = section.locator(".record-table thead");
  const filters = section.locator(".records-filters");
  const sourceFilter = filters.getByLabel("成绩来源", { exact: true });
  const scoreSort = header.getByRole("button", { name: "按分数排序", exact: true });
  const sortHeader = header.locator("th[aria-sort]");
  const pageStatus = section.locator(".records-page-status");
  const showUnplayed = section.getByRole("button", { name: "显示未游玩谱面", exact: true });
  await section.getByRole("button", { name: "清除筛选", exact: true }).click();
  assert.equal(await sourceFilter.inputValue(), "");
  assert.equal(await sortHeader.getAttribute("aria-sort"), "none");
  assert.equal(await filters.count(), 1);
  assert.equal(await header.locator("select, input").count(), 0);
  assert.equal(await filters.getByRole("button", { name: "显示未游玩谱面", exact: true }).count(), 1);
  assert.equal(await filters.getByRole("button", { name: "清除筛选", exact: true }).count(), 1);
  await section.getByRole("button", { name: "下一页", exact: true }).click();
  await sourceFilter.selectOption("munet");
  const munetRecords = Object.values(seed.scores).filter((item) => item.source === "munet");
  assert(munetRecords.length > 10, "source fixture must cover more than one page");
  assert.equal(await rows.count(), 10);
  assert((await pageStatus.innerText()).startsWith("第 1 /"));
  assert((await section.locator(".records-count").innerText()).includes(`共 ${munetRecords.length} 项`));
  for (const row of await rows.all()) assert.equal(await row.locator(".score-source").getAttribute("class"), "score-source munet");
  assert(await showUnplayed.isDisabled());
  await section.getByRole("button", { name: "下一页", exact: true }).click();
  assert((await pageStatus.innerText()).startsWith("第 2 /"));
  const selectedRecord = munetRecords[0];
  const selectedChart = catalog.find((chart) => chart.id === selectedRecord.id && chart.difficulty === selectedRecord.difficulty)!;
  await section.getByRole("searchbox").fill(selectedChart.id);
  await section.getByLabel("难度", { exact: true }).selectOption(selectedChart.difficulty);
  await section.getByLabel("等级", { exact: true }).selectOption(getChartLevel(selectedChart.constant));
  await section.getByLabel("定数", { exact: true }).selectOption(selectedChart.constant.toFixed(1));
  await section.getByLabel("分类", { exact: true }).selectOption(selectedChart.genre);
  await section.getByLabel("版本", { exact: true }).selectOption(selectedChart.version);
  assert.equal(await rows.count(), 1);
  assert.equal(await pageStatus.innerText(), "第 1 / 1 页");
  assert((await rows.first().innerText()).includes(selectedChart.title));
  mark("source filtering lives above the table, combines with catalog filters and search, and resets ten-row pagination");

  await section.getByRole("button", { name: "清除筛选", exact: true }).click();
  const descending = Object.values(seed.scores).sort((left, right) => right.score - left.score);
  const ascending = [...descending].reverse();
  for (const [direction, expected] of [["descending", descending], ["ascending", ascending]] as const) {
    await section.getByRole("button", { name: "下一页", exact: true }).click();
    await scoreSort.click();
    assert.equal(await sortHeader.getAttribute("aria-sort"), direction);
    assert.equal(await pageStatus.innerText(), "第 1 / 5 页");
    assert.equal(await rows.count(), 10);
    const pageRows = await rows.all();
    for (let index = 0; index < pageRows.length; index += 1) {
      assert((await pageRows[index].innerText()).includes(`ID ${expected[index].id}`));
      assert.equal(await pageRows[index].locator(".diff-tag").innerText(), expected[index].difficulty);
    }
  }
  await showUnplayed.click();
  assert((await section.locator(".records-count").innerText()).includes(`共 ${catalog.length} 项`));
  assert.equal(await rows.locator(".records-unplayed").count(), 0);
  await section.getByRole("button", { name: "末页", exact: true }).click();
  assert.equal(await rows.locator(".records-unplayed").count(), await rows.count());
  await sourceFilter.selectOption("munet");
  assert.equal(await showUnplayed.getAttribute("aria-pressed"), "true");
  assert(await showUnplayed.isDisabled());
  assert.equal(await rows.locator(".records-unplayed").count(), 0);
  await sourceFilter.selectOption("");
  assert(await showUnplayed.isEnabled());
  assert((await section.locator(".records-count").innerText()).includes(`共 ${catalog.length} 项`));
  await scoreSort.click();
  assert.equal(await sortHeader.getAttribute("aria-sort"), "none");
  assert((await pageStatus.innerText()).startsWith("第 1 /"));
  await section.getByRole("button", { name: "Rating 排名", exact: true }).click();
  assert.equal(await section.getByLabel("成绩来源", { exact: true }).count(), 0);
  assert.equal(await section.getByRole("button", { name: "按分数排序", exact: true }).count(), 0);
  assert.equal(await header.locator("select").count(), 0);
  assert.equal(await header.getByRole("searchbox").count(), 0);
  assert.equal(await filters.getByRole("searchbox").count(), 1);
  assert.equal(await pageStatus.innerText(), "第 1 / 5 页");
  await section.getByRole("button", { name: "曲库筛选", exact: true }).click();
  await section.getByRole("button", { name: "清除筛选", exact: true }).click();
  mark("score sorting cycles down/up/default in the header, resets pagination, keeps unplayed last and leaves Rating ranking unchanged");
}

async function checkRecordsBrowsing(page: Page, outputDirectory: string, mark: (message: string) => void): Promise<void> {
  const section = page.locator(".records-browser");
  const tableRows = section.locator(".record-table tbody tr");
  const header = section.locator(".record-table thead");
  const search = section.getByRole("searchbox");
  const filters = section.locator(".records-filters");
  assert.equal(await filters.count(), 1);
  assert.equal(await filters.getByRole("searchbox").count(), 1);
  assert.equal(await header.getByRole("searchbox").count(), 0);
  assert.equal(await header.locator("select").count(), 0);
  assert.deepEqual(await header.locator("th").allTextContents().then((texts) => texts.slice(2, 5).map((text) => text.trim())), ["难度", "等级", "定数"]);
  assert.equal(await tableRows.count(), 10);
  assert.equal(await section.getByRole("button", { name: "Rating 排名", exact: true }).getAttribute("aria-pressed"), "true");
  assert((await tableRows.first().innerText()).includes("#1"));
  await section.getByRole("button", { name: "下一页", exact: true }).click();
  assert.equal(await tableRows.count(), 10);
  assert((await tableRows.first().innerText()).includes("#11"));
  await search.fill("冒烟测试别名");
  const aliasMatches = Object.values(seed.scores).filter((item) => item.id === firstChart.id).length;
  assert.equal(await tableRows.count(), aliasMatches);
  assert((await tableRows.first().innerText()).includes(firstChart.title));
  assert.equal(await section.locator(".records-page-status").innerText(), "第 1 / 1 页");
  await search.fill("");
  assert.equal(await tableRows.count(), 10);
  assert.equal(await section.locator(".records-page-status").innerText(), "第 1 / 5 页");
  await search.fill("__ui_smoke_no_matching_rating__");
  assert((await section.locator(".table-empty").innerText()).includes("暂无匹配成绩"));
  assert.equal(Number(await section.locator(".table-empty").getAttribute("colspan")), await header.locator("th").count());
  await search.fill("");
  mark("rating ranking has separate difficulty, level and constant columns, search above the table, ten-row pagination and a full-width empty state");

  await section.getByRole("button", { name: "下一页", exact: true }).click();
  await section.getByRole("button", { name: "曲库筛选", exact: true }).click();
  assert.equal(await filters.count(), 1);
  for (const label of ["难度", "等级", "定数", "分类", "版本", "成绩来源"]) {
    assert.equal(await filters.getByLabel(label, { exact: true }).count(), 1, `${label} filter belongs above the table`);
    assert.equal(await header.getByLabel(label, { exact: true }).count(), 0, `${label} filter must not be duplicated in the table header`);
  }
  assert.equal(await filters.getByRole("searchbox").count(), 1);
  assert.equal(await filters.getByRole("button", { name: "显示未游玩谱面", exact: true }).count(), 1);
  assert.equal(await filters.getByRole("button", { name: "清除筛选", exact: true }).count(), 1);
  assert.equal(await header.locator("select, input").count(), 0);
  assert(await filters.evaluate((element) => element.getBoundingClientRect().bottom <= element.parentElement!.querySelector(".record-table-wrap")!.getBoundingClientRect().top), "all filters must appear above the table");
  assert.equal(await section.locator(".records-page-status").innerText(), "第 1 / 5 页");
  assert.equal(await section.getByRole("button", { name: "显示未游玩谱面", exact: true }).getAttribute("aria-pressed"), "false");
  await section.getByLabel("难度", { exact: true }).selectOption(firstChart.difficulty);
  await section.getByLabel("等级", { exact: true }).selectOption(getChartLevel(firstChart.constant));
  await section.getByLabel("定数", { exact: true }).selectOption(firstChart.constant.toFixed(1));
  await section.getByLabel("分类", { exact: true }).selectOption(firstChart.genre);
  await section.getByLabel("版本", { exact: true }).selectOption(firstChart.version);
  const combinedMatches = catalog.filter((chart) => chart.difficulty === firstChart.difficulty
    && chart.constant === firstChart.constant && chart.genre === firstChart.genre
    && chart.version === firstChart.version && seed.scores[`${chart.id}:${chart.difficulty}`]);
  assert.equal(await tableRows.count(), Math.min(combinedMatches.length, 10));
  assert((await section.locator(".records-count").innerText()).includes(`共 ${combinedMatches.length} 项`));
  assert((await tableRows.first().innerText()).includes(firstChart.genre));
  assert((await tableRows.first().innerText()).includes(firstChart.version));
  for (const row of await tableRows.all()) {
    assert.equal(await row.locator("td").nth(1).innerText(), firstChart.difficulty);
    assert.equal(await row.locator("td").nth(2).innerText(), getChartLevel(firstChart.constant));
    assert.equal(await row.locator("td").nth(3).innerText(), firstChart.constant.toFixed(1));
  }
  mark("catalog search, all six filters and unplayed/reset controls live above the table and combine with separate difficulty, level and constant columns");

  await checkTableSourceAndScoreControls(page, mark);

  await section.getByRole("button", { name: "清除筛选", exact: true }).click();
  for (const label of ["难度", "等级", "定数", "分类", "版本", "成绩来源"]) assert.equal(await section.getByLabel(label, { exact: true }).inputValue(), "");
  const showUnplayed = section.getByRole("button", { name: "显示未游玩谱面", exact: true });
  await showUnplayed.click();
  assert.equal(await showUnplayed.getAttribute("aria-pressed"), "true");
  assert((await section.locator(".records-count").innerText()).includes(`共 ${catalog.length} 项`));
  assert.equal(await tableRows.count(), 10);
  await section.getByRole("button", { name: "下一页", exact: true }).click();
  assert.equal(await tableRows.count(), 10);
  assert((await section.locator(".records-page-status").innerText()).startsWith("第 2 /"));
  for (const level of ["13", "13+"]) {
    const matching = catalog.filter((chart) => getChartLevel(chart.constant) === level);
    assert(matching.length > 10, `${level} fixture must span several pages`);
    await section.getByLabel("等级", { exact: true }).selectOption(level);
    assert.equal(await tableRows.count(), 10);
    assert((await section.locator(".records-count").innerText()).includes(`共 ${matching.length} 项`));
    assert((await section.locator(".records-page-status").innerText()).startsWith("第 1 /"));
    for (const row of await tableRows.all()) {
      assert.equal(await row.locator("td").nth(2).innerText(), level);
      assert.equal(getChartLevel(Number(await row.locator("td").nth(3).innerText())), level);
    }
    await section.getByRole("button", { name: "下一页", exact: true }).click();
    assert((await section.locator(".records-page-status").innerText()).startsWith("第 2 /"));
  }
  const constants = section.getByLabel("定数", { exact: true });
  assert.deepEqual(await constants.locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value).filter(Boolean)), ["13.5", "13.6", "13.7", "13.8", "13.9"]);
  await constants.selectOption("13.5");
  await section.getByLabel("等级", { exact: true }).selectOption("13");
  assert.equal(await constants.inputValue(), "");
  assert.deepEqual(await constants.locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value).filter(Boolean)), ["13.0", "13.1", "13.2", "13.3", "13.4"]);
  await constants.selectOption("13.0");
  const thirteenCharts = catalog.filter((chart) => chart.constant === 13);
  assert(thirteenCharts.length > 10, "13.0+ catalog must include paginated 13.0 charts");
  assert.equal(await tableRows.count(), 10);
  assert((await section.locator(".records-count").innerText()).includes(`共 ${thirteenCharts.length} 项`));
  for (const row of await tableRows.all()) assert.equal(await row.locator("td").nth(3).innerText(), "13.0");
  await section.getByRole("button", { name: "下一页", exact: true }).click();
  assert((await section.locator(".records-page-status").innerText()).startsWith("第 2 /"));
  const thirteenDifficulty = thirteenCharts[0].difficulty;
  await section.getByLabel("难度", { exact: true }).selectOption(thirteenDifficulty);
  const combinedThirteen = thirteenCharts.filter((chart) => chart.difficulty === thirteenDifficulty);
  assert((await section.locator(".records-count").innerText()).includes(`共 ${combinedThirteen.length} 项`));
  assert.equal(await tableRows.count(), Math.min(10, combinedThirteen.length));
  assert((await section.locator(".records-page-status").innerText()).startsWith("第 1 /"));
  for (const row of await tableRows.all()) {
    assert.equal(await row.locator("td").nth(1).innerText(), thirteenDifficulty);
    assert.equal(await row.locator("td").nth(2).innerText(), "13");
    assert.equal(await row.locator("td").nth(3).innerText(), "13.0");
  }
  await section.getByLabel("难度", { exact: true }).selectOption("");
  await section.getByLabel("等级", { exact: true }).selectOption("");
  await section.getByLabel("定数", { exact: true }).selectOption("");
  assert((await section.locator(".records-page-status").innerText()).startsWith("第 1 /"));
  mark("13 and 13+ group their own 0.1 constants, combine with difficulty filters, reset pagination and clear incompatible constant selections");
  const unplayed = catalog.find((chart) => chart.id.length >= 4 && !seed.scores[`${chart.id}:${chart.difficulty}`])!;
  assert(unplayed, "fixture must contain an unplayed catalog chart");
  const unplayedKey = `${unplayed.id}:${unplayed.difficulty}`;
  await search.fill(unplayed.id);
  await section.getByLabel("难度", { exact: true }).selectOption(unplayed.difficulty);
  assert((await section.locator(".records-page-status").innerText()).startsWith("第 1 /"));
  const unplayedRow = tableRows
    .filter({ has: page.getByText(`ID ${unplayed.id}`, { exact: true }) })
    .filter({ has: page.getByText(unplayed.difficulty, { exact: true }) });
  assert((await unplayedRow.innerText()).includes("未游玩"));
  assert.equal(await unplayedRow.getByRole("button", { name: "删除", exact: true }).count(), 0);
  await unplayedRow.getByRole("button", { name: "录入分数", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "录入分数", exact: true });
  await dialog.getByLabel("分数", { exact: true }).fill("1007500");
  await dialog.getByRole("button", { name: "保存修改", exact: true }).click();
  await page.waitForFunction(({ storageKey, key }) => {
    const state = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    return state?.scores[key]?.score === 1_007_500 && state.scores[key].source === "manual";
  }, { storageKey: STORAGE_KEY, key: unplayedKey });
  assert((await unplayedRow.innerText()).includes("神秘游客"));
  assert(await unplayedRow.getByRole("button", { name: "修改分数", exact: true }).isEnabled());
  page.once("dialog", (confirmation) => { void confirmation.accept(); });
  await unplayedRow.getByRole("button", { name: "删除", exact: true }).click();
  await page.waitForFunction(({ storageKey, key }) => {
    const state = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    return state && state.scores[key] === undefined;
  }, { storageKey: STORAGE_KEY, key: unplayedKey });
  assert((await unplayedRow.innerText()).includes("未游玩"));
  assert.equal(Object.keys((await readState(page)).scores).length, 50);
  mark("unplayed charts are optional, paginated, editable as mysterious guest and return to unplayed after deletion");

  await search.fill("__ui_smoke_no_matching_song__");
  assert((await section.locator(".table-empty").innerText()).includes("暂无匹配谱面"));
  assert.equal(Number(await section.locator(".table-empty").getAttribute("colspan")), await header.locator("th").count());
  assert(await section.getByRole("button", { name: "下一页", exact: true }).isDisabled());
  await section.getByRole("button", { name: "清除筛选", exact: true }).click();
  assert.equal(await search.inputValue(), "");
  assert.equal(await showUnplayed.getAttribute("aria-pressed"), "false");
  for (const label of ["难度", "等级", "定数", "分类", "版本", "成绩来源"]) assert.equal(await filters.getByLabel(label, { exact: true }).inputValue(), "");
  assert.equal(await tableRows.count(), 10);
  await showUnplayed.click();
  await section.screenshot({ path: join(outputDirectory, "desktop-records.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await section.screenshot({ path: join(outputDirectory, "mobile-records.png") });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "mobile catalog controls must not overflow the viewport");
  const canScrollTable = await section.locator(".record-table-wrap").evaluate((element) => {
    if (element.scrollWidth <= element.clientWidth) return false;
    element.scrollLeft = element.scrollWidth;
    return element.scrollLeft > 0;
  });
  assert(canScrollTable, "mobile table must scroll internally so all columns remain accessible");
  await section.screenshot({ path: join(outputDirectory, "mobile-records-controls.png") });
  await section.locator(".record-table-wrap").evaluate((element) => { element.scrollLeft = 0; });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await section.getByRole("button", { name: "清除筛选", exact: true }).click();
  await section.getByRole("button", { name: "Rating 排名", exact: true }).click();
  mark("empty catalog rows span every column, reset restores all filters and mobile table scrolls internally without viewport overflow");
}

async function checkCompactTablesAndDetails(page: Page, outputDirectory: string, mark: (message: string) => void): Promise<void> {
  const section = page.locator(".records-browser");
  const table = section.locator(".record-table");
  const header = table.locator("thead");
  const wrapper = section.locator(".record-table-wrap");
  const labels = ["歌曲", "难度", "等级", "定数", "分类", "版本", "来源", "分数", "Rating", "操作"];
  const longChart = catalog.filter((chart) => /[^\x00-\x7f]/.test(chart.title))
    .sort((left, right) => right.title.length - left.title.length)[0];
  assert(longChart.title.length > 40, "catalog must provide a genuinely long title for truncation testing");
  assert(/[^\x00-\x7f]/.test(longChart.title), "details fixture must exercise Unicode text");
  const before = await readState(page);
  const fixture = structuredClone(before);
  fixture.scores[`${longChart.id}:${longChart.difficulty}`] = { ...chartRecord(longChart, 1_009_999, "manual"), combo: "aj" };
  fixture.nicknameOverrides[longChart.id] = ["详情回归测试别名"];
  await page.evaluate(({ key, state }) => localStorage.setItem(key, JSON.stringify(state)), { key: STORAGE_KEY, state: fixture });
  await page.reload({ waitUntil: "networkidle" });
  const readHeaderLabels = async () => header.locator("th").allTextContents().then((texts) => texts.map((text) => text.trim().replace(/\s*[↕↑↓]\s*$/, "")));

  for (const mode of ["Rating 排名", "曲库筛选"] as const) {
    await section.getByRole("button", { name: mode, exact: true }).click();
    const isRating = mode === "Rating 排名";
    assert.deepEqual(await readHeaderLabels(), isRating ? ["排名", ...labels] : labels);
    assert.equal(await table.locator("colgroup col").count(), isRating ? 11 : 10);
    assert.equal(await table.locator("tbody tr").first().locator("td").count(), isRating ? 11 : 10);
    assert.equal(await header.locator("select, input").count(), 0);
    assert.equal(await section.locator(".records-filters").locator("select").count(), isRating ? 0 : 6);
    const dimensions = await table.evaluate((element) => {
      const song = element.querySelector<HTMLElement>("thead th:nth-child(" + (element.querySelector(".records-col-rank") ? "2" : "1") + ")")!;
      const headerSizes = [...element.querySelectorAll("thead th")].map((cell) => Number.parseFloat(getComputedStyle(cell).fontSize));
      const leftAligned = [...element.querySelectorAll("thead th, tbody tr:first-child td")].every((cell) => getComputedStyle(cell).textAlign === "left");
      return {
        song: song.getBoundingClientRect().width,
        difficulty: element.querySelector<HTMLElement>(".records-col-difficulty")!.getBoundingClientRect().width,
        level: element.querySelector<HTMLElement>(".records-col-level")!.getBoundingClientRect().width,
        constant: element.querySelector<HTMLElement>(".records-col-constant")!.getBoundingClientRect().width,
        source: element.querySelector<HTMLElement>(".records-col-source")!.getBoundingClientRect().width,
        headerSizes, leftAligned,
        actions: element.querySelector<HTMLElement>(".records-col-actions")!.getBoundingClientRect().width,
      };
    });
    assert(dimensions.headerSizes.every((size) => size >= 16), "every table header should use a legible enlarged font");
    assert(dimensions.leftAligned, "headers and cells must be left aligned in both modes");
    assert([dimensions.difficulty, dimensions.level, dimensions.constant, dimensions.source].every((width) => Math.abs(width - dimensions.actions) < 1), "auxiliary columns use the same width as actions");
    assert(dimensions.song > Math.max(dimensions.difficulty, dimensions.level, dimensions.constant, dimensions.source), "the title receives more space than compact auxiliary columns");
    assert(await wrapper.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), "1440px desktop must display all columns without horizontal scrolling");
    await section.screenshot({ path: join(outputDirectory, `desktop-compact-${isRating ? "rating" : "catalog"}.png`) });
  }
  mark("Rating and catalog tables share ten left-aligned columns, with one additional Rating rank column, enlarged headers and compact auxiliary widths without desktop scrolling");

  await section.getByRole("button", { name: "Rating 排名", exact: true }).click();
  await section.getByRole("searchbox").fill(longChart.id);
  const row = table.locator("tbody tr").filter({ has: page.getByText(`ID ${longChart.id}`, { exact: true }) })
    .filter({ has: page.getByText(longChart.difficulty, { exact: true }) });
  const titleButton = row.locator(".record-title-details");
  assert.equal(await titleButton.innerText(), longChart.title);
  assert.equal(await titleButton.getAttribute("title"), longChart.title);
  assert.equal(await titleButton.getAttribute("aria-label"), `查看歌曲详情：${longChart.title}`);
  const titleLayout = await titleButton.evaluate((element) => {
    const style = getComputedStyle(element);
    return { nowrap: style.whiteSpace, overflow: style.overflow, ellipsis: style.textOverflow, width: element.clientWidth, fullWidth: element.scrollWidth };
  });
  assert.deepEqual([titleLayout.nowrap, titleLayout.overflow, titleLayout.ellipsis], ["nowrap", "hidden", "ellipsis"]);
  assert(titleLayout.fullWidth > titleLayout.width, "a long song name should truncate inside its own column");
  const stateBeforeDetails = await readState(page);
  await titleButton.click();
  const details = page.getByRole("dialog", { name: longChart.title, exact: true });
  await details.waitFor({ state: "visible" });
  assert.equal(await details.locator(".song-details-chart").count(), 3);
  assert.deepEqual(await details.locator(".song-details-difficulty").allTextContents(), ["EXP", "MAS", "ULT"]);
  const selected = details.locator(`.song-details-${longChart.difficulty.toLowerCase()}`);
  assert.equal(await selected.locator(".score-grade").innerText(), "SSS+");
  assert.equal(await selected.locator(".score-combo-aj").innerText(), "AJ");
  assert((await details.locator(".song-details-aliases").innerText()).includes("详情回归测试别名"));
  assert.equal(await details.getByRole("button", { name: "我的游玩记录", exact: true }).count(), 0);
  await page.keyboard.press("Escape");
  await details.waitFor({ state: "hidden" });
  await titleButton.click();
  await details.getByRole("button", { name: "关闭歌曲详情", exact: true }).click();
  await details.waitFor({ state: "hidden" });
  assert.deepEqual(await page.evaluate(() => window.__smokeClipboard.calls), []);
  assert.deepEqual(await readState(page), stateBeforeDetails);
  mark("long Unicode titles truncate and open details; EXP/MAS/ULT, grade, AJ and expanded aliases are retained; close and Escape preserve scores without copying");

  await page.setViewportSize({ width: 390, height: 844 });
  await section.screenshot({ path: join(outputDirectory, "mobile-compact-rating.png") });
  await section.getByRole("button", { name: "曲库筛选", exact: true }).click();
  await section.screenshot({ path: join(outputDirectory, "mobile-compact-catalog.png") });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "compact tables and filters must not overflow the mobile page");
  assert(await wrapper.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    return element.scrollWidth > element.clientWidth && element.scrollLeft > 0;
  }), "compact table must remain scrollable inside its wrapper on mobile");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(({ key, state }) => localStorage.setItem(key, JSON.stringify(state)), { key: STORAGE_KEY, state: before });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".source-tools-toggle").click();
  mark("both compact table modes render on mobile with internal table scrolling and no page overflow");
}

async function main(): Promise<void> {
  const outputDirectory = await mkdtemp("/tmp/machun-ui-smoke-");
  const manager = new FakeManager();
  const server = createAppServer({ manager, distDirectory: join(projectDirectory, "dist") });
  let browser: Browser | undefined;
  let page: Page | undefined;
  const checks: string[] = [];
  const pageErrors: string[] = [];
  let mockedImages = 0;
  const mark = (message: string) => { checks.push(message); console.log(`PASS ${message}`); };
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = server.address();
    assert(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin) { await route.continue(); return; }
      if (route.request().resourceType() === "image") {
        mockedImages += 1;
        await route.fulfill({ status: 200, contentType: "image/png", headers: { "Access-Control-Allow-Origin": "*" }, body: onePixelPng });
      } else {
        await route.abort();
      }
    });
    // Raw JavaScript avoids tsx name helpers being serialized into the browser context.
    await context.addInitScript({ content: `(() => {
      const key = ${JSON.stringify(STORAGE_KEY)};
      if (location.origin === ${JSON.stringify(origin)} && localStorage.getItem(key) === null) {
        localStorage.setItem(key, ${JSON.stringify(JSON.stringify(seed))});
      }
      const clipboard = { mode: "success", calls: [], fallbackCalls: [] };
      window.__smokeClipboard = clipboard;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        get: function () {
          return clipboard.mode === "missing" ? undefined : {
            writeText: async function (text) {
              clipboard.calls.push(text);
              if (clipboard.mode === "denied") throw new DOMException("Smoke clipboard denied", "NotAllowedError");
            }
          };
        }
      });
      document.execCommand = function (command) {
        if (command !== "copy" || !(document.activeElement instanceof HTMLTextAreaElement)) return false;
        clipboard.fallbackCalls.push(document.activeElement.value);
        return true;
      };
    })();` });
    page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator(".source-tools-toggle").click();
    const sourceCard = (source: ExternalScoreSource) => page!.locator(`.source-card.${source}`);
    const waitStatus = (source: ExternalScoreSource, status: string) => sourceCard(source).locator(".source-connection-status").filter({ hasText: new RegExp(`^${status}$`) }).waitFor();
    for (const source of SYNC_SOURCES) {
      await waitStatus(source, "未绑定");
      assert(await sourceCard(source).getByRole("button", { name: "同步成绩", exact: true }).isDisabled());
    }
    assert.equal(Object.keys((await readState(page)).scores).length, 50);
    mark("initial unbound states and isolated 50-record fixture");

    const previewToggle = page.locator(".b30-preview-toggle");
    assert.equal(await previewToggle.getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator(".b30-card").count(), 0);
    await previewToggle.click();
    assert.equal(await previewToggle.getAttribute("aria-expanded"), "true");
    assert.equal(await page.locator(".b30-card").count(), 30);
    assert.equal(await page.locator(".b30-grid").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length), 3);
    await previewToggle.click();
    assert.equal(await page.locator(".b30-card").count(), 0);
    const axis = getB30Axis(Object.values(seed.scores));
    const metrics = page.locator(".analysis-metrics > div");
    assert((await metrics.nth(0).innerText()).includes("B1 + 0.2 向下取整"));
    assert.equal(await metrics.nth(0).locator("strong").innerText(), axis.max.toFixed(1));
    assert((await metrics.nth(1).innerText()).includes("B30 − 0.2 向上取整"));
    assert.equal(await metrics.nth(1).locator("strong").innerText(), axis.min.toFixed(1));
    assert.equal(await metrics.nth(2).locator("strong").innerText(), (Math.floor((Object.values(seed.scores).sort((a, b) => b.rating - a.rating).slice(0, 30).reduce((sum, record) => sum + record.rating, 0) / 30 + 1e-9) * 100) / 100).toFixed(2));
    mark("B30 image preview is collapsed by default and its chart displays rounded upper/lower bounds plus truncated B30 average Rating");
    await checkRecordsBrowsing(page, outputDirectory, mark);
    await checkCompactTablesAndDetails(page, outputDirectory, mark);

    await sourceCard("munet").getByRole("button", { name: "绑定账号", exact: true }).click();
    await waitStatus("munet", "等待网页登录");
    assert(await sourceCard("rin").getByRole("button", { name: "绑定账号", exact: true }).isEnabled());
    await sourceCard("munet").getByRole("button", { name: "取消绑定", exact: true }).click();
    await waitStatus("munet", "未绑定");
    assert.equal((await readState(page)).scores[firstKey].score, 1_000_000);
    mark("binding can be cancelled without blocking another source or deleting scores");

    for (const source of ["munet", "rin", "otogame"] as const) {
      await sourceCard(source).getByRole("button", { name: "绑定账号", exact: true }).click();
      await waitStatus(source, "等待网页登录");
      if (source === "rin") {
        await page.reload({ waitUntil: "networkidle" });
        await page.locator(".source-tools-toggle").click();
        await waitStatus(source, "等待网页登录");
      }
      const callsBeforeCompletion = manager.listCalls;
      manager.completeBinding(source);
      await waitStatus(source, "已绑定");
      assert(manager.listCalls > callsBeforeCompletion, "binding completion must be observed by polling");
      assert((await sourceCard(source).locator(".source-identity").innerText()).includes(`${source} 测试玩家`));
    }
    mark("all browser sources bind through polling; page reload restores an in-progress binding");

    const lxns = sourceCard("lxns");
    assert(await lxns.getByRole("button", { name: "保存 Token", exact: true }).isDisabled());
    await lxns.getByLabel("个人 API Token", { exact: true }).fill(fakeToken);
    await lxns.getByRole("button", { name: "保存 Token", exact: true }).click();
    await waitStatus("lxns", "已绑定");
    assert.equal(manager.receivedToken, fakeToken);
    assert.equal(await lxns.locator('input[type="password"]').count(), 0);
    assert(!(await page.evaluate(() => JSON.stringify(localStorage))).includes(fakeToken));
    await page.reload({ waitUntil: "networkidle" });
    await page.locator(".source-tools-toggle").click();
    for (const source of SYNC_SOURCES) await waitStatus(source, "已绑定");
    mark("LXNS token binds once, clears from the form, stays out of score storage; all bindings restore on refresh");

    for (const source of SYNC_SOURCES) {
      await sourceCard(source).getByRole("button", { name: "同步成绩", exact: true }).click();
      await waitForScore(page, manager.scores.get(source)!, source);
      await waitStatus(source, "已绑定");
      assert.equal(manager.syncCalls.get(source), 1);
      assert(!(await sourceCard(source).locator(".source-sync-history").innerText()).includes("尚未同步"));
    }
    mark("manual sync works independently for all four sources and updates the last-success display");

    manager.holdNextSync("rin", 1_005_000);
    await sourceCard("rin").getByRole("button", { name: "同步成绩", exact: true }).click();
    await waitStatus("rin", "正在同步");
    assert(await sourceCard("rin").getByRole("button", { name: "正在同步", exact: true }).isDisabled());
    assert(await sourceCard("munet").getByRole("button", { name: "同步成绩", exact: true }).isEnabled());
    await editScore(page, 1_009_000);
    manager.releaseSync();
    await waitStatus("rin", "已绑定");
    await waitForScore(page, 1_009_000, "manual");
    mark("a delayed lower sync result preserves a higher manual edit made during the request");

    await editScore(page, 990_000);
    await sourceCard("rin").getByRole("button", { name: "同步成绩", exact: true }).click();
    await waitForScore(page, 1_005_000, "rin");
    assert.deepEqual((await readState(page)).nicknameOverrides, seed.nicknameOverrides);
    assert.equal(Object.keys((await readState(page)).scores).length, 50);
    mark("a higher external score updates a deliberately lowered manual score without losing unrelated records or aliases");

    await checkNationalRepair(page, manager, outputDirectory, mark);

    await page.locator(".source-section").screenshot({ path: join(outputDirectory, "desktop-sources.png") });
    await page.locator(".b30-section").screenshot({ path: join(outputDirectory, "desktop-b30.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(".source-section").screenshot({ path: join(outputDirectory, "mobile-sources.png") });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "mobile page must not overflow horizontally");
    await page.setViewportSize({ width: 1440, height: 1000 });
    mark("desktop and mobile screenshots captured without horizontal mobile overflow");

    const exportCases = [
      { label: "导出 B30 JSON", candidates: false, kind: "json" },
      { label: "导出 B30 + 候选20 JSON", candidates: true, kind: "json" },
      { label: "导出 B30 图片", candidates: false, kind: "png" },
      { label: "导出 B30 + 候选20 图片", candidates: true, kind: "png" },
    ] as const;
    const downloadedFiles: string[] = [];
    for (const item of exportCases) {
      const downloadPromise: Promise<Download> = page.waitForEvent("download");
      await page.getByRole("button", { name: item.label, exact: true }).click();
      const download: Download = await downloadPromise;
      const path = join(outputDirectory, download.suggestedFilename());
      await download.saveAs(path);
      assert.equal(await download.failure(), null);
      const buffer = await readFile(path);
      if (item.kind === "json") {
        const data = JSON.parse(buffer.toString("utf8")).data;
        assert.equal(data.base_rating_list.length, 30);
        assert.equal(data.next_rating_list.length, item.candidates ? 20 : 0);
      } else {
        assert(buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
        assert.equal(buffer.readUInt32BE(16), 2360);
        assert.equal(buffer.readUInt32BE(20), item.candidates ? 1792 : 1120);
      }
      assert(!buffer.includes(Buffer.from(fakeToken)));
      downloadedFiles.push(path);
    }
    assert(mockedImages > 0, "remote cover images must be mocked");
    mark("both B30 JSON variants and both PNG variants download with valid counts, dimensions and no token");

    const beforeUnbind = await readState(page);
    for (const source of SYNC_SOURCES) {
      await sourceCard(source).getByRole("button", { name: "解绑", exact: true }).click();
      await waitStatus(source, "未绑定");
      assert(await sourceCard(source).getByRole("button", { name: "同步成绩", exact: true }).isDisabled());
    }
    assert.deepEqual(await readState(page), beforeUnbind);
    assert.deepEqual(pageErrors, []);
    mark("unbinding all sources preserves scores and aliases; no browser page errors");
    await writeFile(join(outputDirectory, "report.json"), JSON.stringify({
      checks, downloadedFiles, mockedImages, pageErrors, fixtureChart: firstKey,
      browser: "isolated Google Chrome", backend: "in-memory fake manager", externalRequests: "intercepted or blocked",
    }, null, 2));
    console.log(`ARTIFACTS ${outputDirectory}`);
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: join(outputDirectory, "failure.png"), fullPage: true }).catch(() => undefined);
    console.error(`FAIL ${error instanceof Error ? error.stack : String(error)}`);
    console.error(`ARTIFACTS ${outputDirectory}`);
    process.exitCode = 1;
  } finally {
    manager.releaseSync();
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

await main();
