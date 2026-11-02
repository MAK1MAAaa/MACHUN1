import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogChart, SingleRating } from "../types";
import { createAjB30Export, createB30CandidatesExport, createB30Export, createB50Export, generateB30Png } from "./b30Export";

describe("B30 PNG generation", () => {
  const drawnText: string[] = [];
  const drawnPositions: Array<{ text: string; x: number; y: number }> = [];
  const drawnLines: Array<{ fromX: number; fromY: number; toX: number; toY: number }> = [];
  const drawnImages: Array<{ image: unknown; x: number; y: number; width: number; height: number }> = [];
  let lineStart = { x: 0, y: 0 };
  const encodedSizes: Array<{ width: number; height: number }> = [];
  const generatedBlob = new Blob(["png"], { type: "image/png" });
  const context = new Proxy({}, {
    get(_target, property) {
      if (property === "measureText") return (text: string) => ({ width: text.length * 6 });
      if (property === "fillText") return (text: string, x: number, y: number) => { drawnText.push(text); drawnPositions.push({ text, x, y }); };
      if (property === "drawImage") return (image: unknown, x: number, y: number, width: number, height: number) => { drawnImages.push({ image, x, y, width, height }); };
      if (property === "moveTo") return (x: number, y: number) => { lineStart = { x, y }; };
      if (property === "lineTo") return (x: number, y: number) => { drawnLines.push({ fromX: lineStart.x, fromY: lineStart.y, toX: x, toY: y }); lineStart = { x, y }; };
      if (property === "createLinearGradient") return () => ({ addColorStop() { /* Canvas test double */ } });
      return () => undefined;
    },
    set() { return true; },
  });
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
    toBlob: vi.fn<(callback: BlobCallback, type?: string) => void>(),
  };
  const createElement = vi.fn((tag: string) => {
    if (tag !== "canvas") throw new Error(`Unexpected browser side effect: ${tag}`);
    return canvas;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    drawnText.length = 0;
    drawnPositions.length = 0;
    drawnLines.length = 0;
    drawnImages.length = 0;
    encodedSizes.length = 0;
    canvas.width = 0;
    canvas.height = 0;
    canvas.getContext.mockReturnValue(context);
    canvas.toBlob.mockImplementation((callback) => {
      encodedSizes.push({ width: canvas.width, height: canvas.height });
      queueMicrotask(() => callback(generatedBlob));
    });
    vi.stubGlobal("window", {
      setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    });
    vi.stubGlobal("document", { createElement, fonts: { ready: Promise.resolve() } });
    vi.stubGlobal("Image", class {
      naturalWidth = 459;
      naturalHeight = 199;
      onload?: () => void;
      onerror?: () => void;
      set src(url: string) { if (url) queueMicrotask(() => this.onload?.()); }
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function makeRecord(id: string, combo: SingleRating["combo"]): SingleRating {
    return {
      id,
      title: `Song ${id}`,
      difficulty: "MAS",
      constant: 14,
      score: 1_009_000,
      rating: 16.15,
      updatedAt: "2026-10-13T00:00:00Z",
      source: "rin",
      combo,
      fullChain: "gold",
    };
  }

  it("renders B50 as six OLD rows and four NEW rows with adjacent group averages and independent ranks", async () => {
    const old = { ...makeRecord("old", undefined), clear: "absolute" as const };
    const fresh = makeRecord("new", "aj");
    const chart = (score: SingleRating, version: string): CatalogChart => ({ ...score, version,
      genre: "ORIGINAL", nickname: [], coverUrl: "", bpm: null,
      notes: { total: 0, tap: 0, hold: 0, slide: 0, air: 0, flick: 0 } });
    const data = createB50Export([old, fresh], new Map([
      ["old:MAS", chart(old, "AIR PLUS")], ["new:MAS", chart(fresh, "MATE")],
    ]), "test", "2026-11-02T00:00:00Z");
    const result = await generateB30Png(data, { nickname: "示例昵称" });
    expect(result).toEqual({ blob: generatedBlob, filename: "machun1-b50-2026-11-02.png", missingCovers: 0 });
    expect(encodedSizes).toEqual([{ width: 2360, height: 2268 }]);
    expect(drawnText).toEqual(expect.arrayContaining(["B50", "OLD 30", "NEW 20", "示例昵称", "Rin服", "ABSOLUTE", "ALL JUSTICE", "SSS+"]));
    expect(drawnText.filter(text => text === "EMPTY SLOT")).toHaveLength(48);
    expect(drawnText.filter(text => text === "#01")).toHaveLength(2);
    expect(drawnText.filter(text => text === "#20")).toHaveLength(2);
    expect(drawnText).toContain("#30");
    expect(drawnText).not.toContain("#31");
    expect(drawnText).not.toContain("C20 · B31–B50");

    for (const [label, average, headingY] of [["OLD 30", data.summary.oldAverage, 166], ["NEW 20", data.summary.newAverage, 1426]] as const) {
      const heading = drawnPositions.find(position => position.text === label)!;
      const groupAverage = drawnPositions.find(position => position.text === average.toFixed(4) && position.y === heading.y)!;
      expect(heading).toEqual({ text: label, x: 40, y: headingY });
      expect(groupAverage.x).toBe(heading.x + label.length * 6 + 20);
      expect(drawnLines).toContainEqual({ fromX: 40, fromY: headingY - 33, toX: 2320, toY: headingY - 33 });
    }
    const firstRanks = drawnPositions.filter(position => position.text === "#01");
    expect(firstRanks[0].y).toBe(200);
    expect(firstRanks[1].y).toBe(1460);
    expect(drawnPositions.find(position => position.text === "B50")?.y).toBe(85);
    expect(drawnPositions.find(position => position.text === data.summary.average.toFixed(4) && position.y === 85)).toBeDefined();
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it("retains both fixed B50 groups when no eligible score is available", async () => {
    await generateB30Png(createB50Export([], new Map(), "test"));
    expect(encodedSizes).toEqual([{ width: 2360, height: 2268 }]);
    expect(drawnText.filter(text => text === "EMPTY SLOT")).toHaveLength(50);
    expect(drawnText.filter(text => text === "#01")).toHaveLength(2);
    expect(drawnText.filter(text => text === "#30")).toHaveLength(1);
    expect(drawnText.filter(text => text === "0.0000")).toHaveLength(3);
  });

  it("generates the original 5×6 PNG with marks and source, without starting a download", async () => {
    const data = createB30Export([makeRecord("1", "fc"), makeRecord("2", "aj")], new Map(), "test", "2026-10-13T00:00:00Z");
    const result = await generateB30Png(data);
    expect(result).toEqual({ blob: generatedBlob, filename: "machun1-b30-2026-10-13.png", missingCovers: 0 });
    expect(encodedSizes).toEqual([{ width: 2360, height: 1360 }]);
    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/png");
    expect(createElement.mock.calls).toEqual([["canvas"]]);
    expect(drawnText).toEqual(expect.arrayContaining(["FULL COMBO", "ALL JUSTICE", "SSS+", "金 FCHAIN", "MASTER 14.0", "Rin服", "Rating: 16.1500"]));
    expect(drawnText).toContain("B30");
    expect(drawnText).toContain("神秘游客");
    expect(drawnText).not.toContain("AJ B30");
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it("generates an AJ-only 5×6 PNG with a distinct title and filename", async () => {
    const data = createAjB30Export(
      [makeRecord("1", "fc"), makeRecord("2", "aj"), makeRecord("3", "ajc"), makeRecord("4", undefined)],
      new Map(),
      "test",
      "2026-10-17T00:00:00Z",
    );
    const result = await generateB30Png(data);
    expect(result).toEqual({ blob: generatedBlob, filename: "machun1-aj-b30-2026-10-17.png", missingCovers: 0 });
    expect(encodedSizes).toEqual([{ width: 2360, height: 1360 }]);
    expect(drawnText).toEqual(expect.arrayContaining(["AJ B30", "ALL JUSTICE", "ALL JUSTICE CRITICAL", "SSS+", "金 FCHAIN", "MASTER 14.0", "Song 2", "Song 3"]));
    expect(drawnText).not.toContain("B30");
    expect(drawnText).not.toContain("FC");
    expect(drawnText).not.toContain("Song 1");
    expect(drawnText).not.toContain("Song 4");
    expect(drawnText.filter((text) => text === "EMPTY SLOT")).toHaveLength(28);
    expect(createElement.mock.calls).toEqual([["canvas"]]);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it("retains the 5×10 candidate image and candidate separator dimensions", async () => {
    const data = createB30CandidatesExport([], new Map(), "test");
    const result = await generateB30Png(data);
    expect(result.filename).toMatch(/^machun1-b30-candidates20-\d{4}-\d{2}-\d{2}\.png$/);
    expect(encodedSizes).toEqual([{ width: 2360, height: 2224 }]);
    expect(drawnText.filter((text) => text === "EMPTY SLOT")).toHaveLength(50);
    expect(drawnText).toContain("B30 + C20");
    const lastBest = drawnPositions.find(({ text }) => text === "#30")!;
    const firstCandidate = drawnPositions.find(({ text }) => text === "#31")!;
    const divider = drawnPositions.find(({ text }) => text === "C20 · B31–B50")!;
    expect(divider.y).toBeGreaterThan(lastBest.y + 168);
    expect(divider.y).toBeLessThan(firstCandidate.y - 20);
    const segments = drawnLines.filter(line => line.fromY === divider.y - 6 && line.toY === divider.y - 6);
    expect(segments).toHaveLength(2);
    expect(segments[0].fromX).toBe(40);
    expect(segments[0].toX).toBeLessThan(divider.x);
    expect(segments[1].fromX).toBeGreaterThan(divider.x);
    expect(segments[1].toX).toBe(2320);
  });

  it.each(["b30", "aj", "candidates"] as const)("places the official logo, nickname, %s title and plain average together without a date caption", async mode => {
    const records = [makeRecord("1", "aj")];
    const data = mode === "aj" ? createAjB30Export(records, new Map(), "test")
      : mode === "candidates" ? createB30CandidatesExport(records, new Map(), "test")
      : createB30Export(records, new Map(), "test");
    await generateB30Png(data, { nickname: "我的昵称" });
    const title = mode === "aj" ? "AJ B30" : mode === "candidates" ? "B30 + C20" : "B30";
    const namePosition = drawnPositions.find(({ text }) => text === "我的昵称")!;
    const titlePosition = drawnPositions.find(({ text }) => text === title)!;
    const ratingPosition = drawnPositions.find(({ text, y }) => text === data.summary.average.toFixed(4) && y === titlePosition.y)!;
    const logo = drawnImages.find(image => image.x === 40 && image.y === 20)!;
    expect(logo.height).toBe(84);
    expect(namePosition.x).toBeCloseTo(40 + 84 * 459 / 199 + 28);
    expect(namePosition.x + "我的昵称".length * 6).toBeLessThan(titlePosition.x);
    expect(titlePosition.x).toBe(namePosition.x + "我的昵称".length * 6 + 32);
    expect(ratingPosition.x).toBe(titlePosition.x + `${title}  `.length * 6);
    expect(ratingPosition.y).toBe(namePosition.y);
    expect(drawnText.some(text => text.startsWith("MACHUN1 · "))).toBe(false);
    expect(drawnPositions.some(({ text, y }) => y === 85 && text.startsWith('Rating:'))).toBe(false);
  });

  it("normalizes multiline nicknames, ellipsizes long names without breaking emoji, and falls back on whitespace", async () => {
    const data = createB30Export([], new Map(), "test");
    await generateB30Png(data, { nickname: "  示例\n昵称\t  " });
    expect(drawnText).toContain("示例 昵称");
    drawnPositions.length = 0;
    await generateB30Png(data, { nickname: "😀".repeat(200) });
    const namePosition = drawnPositions.find(position => position.y === 85)!;
    const name = namePosition.text;
    expect(name.endsWith("…")).toBe(true);
    expect(Array.from(name.slice(0, -1)).every(character => character === "😀")).toBe(true);
    const titlePosition = drawnPositions.find(({ text }) => text === 'B30')!;
    const averagePosition = drawnPositions.find(({ text }) => text === data.summary.average.toFixed(4))!;
    expect(namePosition.x + name.length * 6 + 32).toBe(titlePosition.x);
    expect(averagePosition.x + data.summary.average.toFixed(4).length * 6).toBeLessThanOrEqual(2320);
    await generateB30Png(data, { nickname: " \n " });
    expect(drawnText).toContain("神秘游客");
  });

  it("places source above score, rank at the right, and CLEAR before grade when no combo exists", async () => {
    const record = { ...makeRecord("clear", undefined), clear: "absolute" as const };
    await generateB30Png(createB30Export([record], new Map(), "test"));
    const source = drawnPositions.find(({ text }) => text === "Rin服")!;
    const rank = drawnPositions.find(({ text }) => text === "#01")!;
    const score = drawnPositions.find(({ text }) => text === "1,009,000")!;
    const status = drawnPositions.find(({ text }) => text === "ABSOLUTE")!;
    const grade = drawnPositions.find(({ text }) => text === "SSS+")!;
    expect(source.x).toBeLessThan(rank.x);
    expect(source.y).toBeLessThan(score.y);
    expect(status.x).toBeLessThan(grade.x);
    expect(status.y).toBe(grade.y);
  });

  it("prefers combo lamps without inventing a CLEAR for unknown records", async () => {
    const records = [
      { ...makeRecord("combo", "aj"), clear: "absolute" as const },
      { ...makeRecord("failed", undefined), clear: "failed" as const },
      makeRecord("unknown", undefined),
    ];
    await generateB30Png(createB30Export(records, new Map(), "test"));
    expect(drawnText).toContain("ALL JUSTICE");
    expect(drawnText).not.toContain("ABSOLUTE");
    expect(drawnText).toContain("FAILED");
    expect(drawnText).toContain("—");
    expect(drawnText).not.toContain("CLEAR");
  });

  it("keeps failed covers as placeholders and reports their count", async () => {
    vi.stubGlobal("Image", class {
      onerror?: () => void;
      set src(url: string) { if (url) queueMicrotask(() => this.onerror?.()); }
    });
    const data = createB30Export([makeRecord("1", "fc")], new Map(), "test");
    data.b30[0]!.coverUrl = "https://example.com/missing.jpg";
    const result = await generateB30Png(data);
    expect(result.missingCovers).toBe(1);
    expect(drawnText).toContain("NO COVER");
    expect(drawnText).toContain("CHUNITHM");
    expect(drawnText).toContain("MATE");
  });

  it('falls back from a stalled logo without counting it as a missing cover', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Image', class { set src(_url: string) { /* Stall without a decoder event. */ } });
    const pending = generateB30Png(createB30Export([], new Map(), 'test'));
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await pending).missingCovers).toBe(0);
    expect(drawnText).toContain('MATE');
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails clearly if the browser cannot encode PNG, and releases the canvas buffer", async () => {
    canvas.toBlob.mockImplementationOnce((callback) => callback(null));
    await expect(generateB30Png(createB30Export([], new Map(), "test"))).rejects.toThrow("B30 图片生成失败");
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it("reports a thrown encoding error without leaving a pending timer", async () => {
    vi.useFakeTimers();
    canvas.toBlob.mockImplementationOnce(() => { throw new DOMException("tainted", "SecurityError"); });
    await expect(generateB30Png(createB30Export([], new Map(), "test"))).rejects.toThrow("tainted");
    expect(vi.getTimerCount()).toBe(0);
    expect(canvas.width).toBe(0);
  });

  it("times out a stalled encoder instead of leaving the image generation state busy forever", async () => {
    vi.useFakeTimers();
    canvas.toBlob.mockImplementationOnce(() => undefined);
    const pending = generateB30Png(createB30Export([], new Map(), "test"));
    const rejected = expect(pending).rejects.toThrow("B30 图片生成超时");
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it("uses fallback fonts if font loading stalls, without blocking the export", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { createElement, fonts: { ready: new Promise(() => undefined) } });
    const pending = generateB30Png(createB30Export([], new Map(), "test"));
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await pending).blob).toBe(generatedBlob);
  });
});
