import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Difficulty, SingleRating } from "../types";
import type { ConstantTableEntry, ConstantTableGroup } from "./constantTable";
import { generateConstantTablePng } from "./constantTableExport";

vi.mock("./exportBrand", () => ({
  loadMateLogo: async () => null,
  drawMateLogo: () => 120,
}));

describe("constant table PNG", () => {
  const texts: Array<{ text: string; x: number; y: number }> = [];
  const rectangles: Array<{ style: unknown; x: number; y: number; width: number; height: number }> = [];
  const gradients: string[][] = [];
  const lines: number[] = [];
  const scales: number[] = [];
  const encoded: Array<{ width: number; height: number }> = [];
  const imageUrls: string[] = [];
  let fillStyle: unknown;
  let imageMode: "loaded" | "error" | "zero" | "decode-error" | "pending" = "loaded";
  const blob = new Blob(["png"], { type: "image/png" });
  const context = new Proxy({}, {
    get(_target, key) {
      if (key === "measureText") return (text: string) => ({ width: Array.from(text).length * 8 });
      if (key === "fillText") return (text: string, x: number, y: number) => texts.push({ text, x, y });
      if (key === "fillRect") return (x: number, y: number, width: number, height: number) => rectangles.push({ style: fillStyle, x, y, width, height });
      if (key === "lineTo") return (_x: number, y: number) => lines.push(y);
      if (key === "scale") return (scale: number) => scales.push(scale);
      if (key === "createLinearGradient") return () => {
        const colors: string[] = []; gradients.push(colors);
        return { addColorStop: (_stop: number, color: string) => colors.push(color) };
      };
      return () => undefined;
    },
    set(_target, key, value) { if (key === "fillStyle") fillStyle = value; return true; },
  });
  const canvas = { width: 0, height: 0, getContext: vi.fn(() => context), toBlob: vi.fn<(callback: BlobCallback, type: string) => void>() };
  const createElement = vi.fn(() => canvas);
  const options = (showScores = false) => ({ showScores, filters: { difficulty: "" as const, level: "", constants: ["14.0"], genre: "", version: "" } });

  function entry(id: string, difficulty: Difficulty = "MAS", combo?: SingleRating["combo"], played = true, coverUrl = ""): ConstantTableEntry {
    return {
      chart: { id, title: `Song ${id}`, difficulty, constant: 14, genre: "ORIGINAL", version: "MATE", nickname: [], coverUrl, bpm: 180,
        notes: { total: 0, tap: 0, hold: 0, slide: 0, air: 0, flick: 0 } },
      record: played ? { id, title: `Song ${id}`, difficulty, constant: 14, score: 1_009_000, rating: 16.15, source: "rin", updatedAt: "2026-11-01T00:00:00.000Z", ...(combo ? { combo } : {}) } : undefined,
      releaseDate: "2026-01-01",
    };
  }
  const group = (entries: ConstantTableEntry[]): ConstantTableGroup[] => [{ constant: "14.0", entries }];
  function covers() { return rectangles.filter(rectangle => ["#26212e", "#8b4bb7", "#dd2636"].includes(String(rectangle.style))); }

  beforeEach(() => {
    vi.clearAllMocks(); texts.length = rectangles.length = gradients.length = lines.length = scales.length = encoded.length = imageUrls.length = 0;
    imageMode = "loaded"; canvas.width = canvas.height = 0; canvas.getContext.mockReturnValue(context);
    canvas.toBlob.mockImplementation(callback => { encoded.push({ width: canvas.width, height: canvas.height }); queueMicrotask(() => callback(blob)); });
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("document", { createElement, fonts: { ready: Promise.resolve() } });
    vi.stubGlobal("Image", class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = imageMode === "zero" ? 0 : 100;
      naturalHeight = 100;
      decode() { return imageMode === "decode-error" ? Promise.reject(new Error("bad image")) : Promise.resolve(); }
      set src(value: string) {
        if (!value) return;
        imageUrls.push(value);
        if (imageMode !== "pending") queueMicrotask(() => imageMode === "error" ? this.onerror?.() : this.onload?.());
      }
    });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("uses at most ten square covers per row in the supplied order and preserves difficulty rings", async () => {
    const entries = Array.from({ length: 11 }, (_, index) => entry(String(index), index < 3 ? (["ULT", "MAS", "EXP"] as const)[index] : "MAS"));
    const before = JSON.stringify(entries);
    const result = await generateConstantTablePng(group(entries), options());
    expect(result.blob).toBe(blob);
    expect(result.filename).toMatch(/^machun1-constant-table-\d{4}-\d{2}-\d{2}\.png$/);
    const frames = covers();
    expect(frames).toHaveLength(11);
    expect(frames.slice(0, 3).map(frame => frame.style)).toEqual(["#26212e", "#8b4bb7", "#dd2636"]);
    expect(new Set(frames.slice(0, 10).map(frame => frame.y)).size).toBe(1);
    expect(frames[10].x).toBe(frames[0].x);
    expect(frames[10].y).toBeGreaterThan(frames[9].y);
    expect(frames.every(frame => frame.width === frame.height)).toBe(true);
    expect(texts.map(text => text.text)).not.toContain("1,009,000");
    expect(texts.map(text => text.text)).not.toContain("SSS+");
    expect(JSON.stringify(entries)).toBe(before);
    expect(canvas.width).toBe(0); expect(canvas.height).toBe(0);
  });

  it("joins two equal squares into each score card, wraps after five and renders all four achievement appearances", async () => {
    const entries = [entry("a"), entry("b", "MAS", "fc"), entry("c", "MAS", "aj"), entry("d", "MAS", "ajc"), entry("e", "MAS", undefined, false), entry("f")];
    const result = await generateConstantTablePng(group(entries), options(true));
    const frames = covers();
    expect(result.filename).toContain("constant-table-scores-");
    expect(new Set(frames.slice(0, 5).map(frame => frame.y)).size).toBe(1);
    expect(frames[5].y).toBeGreaterThan(frames[4].y);
    for (const frame of frames) expect(rectangles.some(rect => rect.x === frame.x + frame.width && rect.y === frame.y && rect.width === frame.width && rect.height === frame.height)).toBe(true);
    expect(texts.map(text => text.text)).toEqual(expect.arrayContaining(["1,009,000", "SSS+", "CLEAR", "FULL COMBO", "ALL JUSTICE", "AJC", "未游玩"]));
    expect(texts.map(text => text.text)).not.toContain("FC");
    expect(texts.map(text => text.text)).not.toContain("AJ");
    expect(rectangles.some(rect => rect.style === "#fff4c7")).toBe(true);
    expect(gradients).toEqual(expect.arrayContaining([
      ["#f3a5bc", "#ffe08c", "#b0e0a1", "#9dc9ef", "#c7a5e8"],
      ["#dc7097", "#e2b64e", "#74b76d", "#5998cf", "#a179ca"],
    ]));
  });

  it("keeps each constant group separate and places the title after the logo without a nickname or branding date line", async () => {
    const opts = options(); opts.filters.constants = ["14.0", "14.1"];
    await generateConstantTablePng([{ constant: "14.1", entries: [entry("new", "ULT")] }, { constant: "14.0", entries: [entry("old", "EXP")] }], opts);
    const first = texts.find(text => text.text === "14.1")!, second = texts.find(text => text.text === "14.0")!;
    expect(first.y).toBeLessThan(second.y);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBeGreaterThan(covers()[0].y + covers()[0].height);
    expect(lines[0]).toBeLessThan(second.y);
    const title = texts.find(text => text.text === "定数表")!;
    expect(title.x).toBe(40 + 120 + 22);
    expect(title.y).toBe(76);
    expect(texts.map(text => text.text)).not.toContain("测试玩家");
    expect(texts.map(text => text.text)).not.toContain("神秘游客");
    expect(texts.some(text => text.text.includes("MACHUN1 ·"))).toBe(false);
  });

  it("exports consecutive available options across the missing 15.9 without creating a phantom group", async () => {
    const optionsWithGap = { ...options(), filters: { ...options().filters, difficulty: "ULT" as const, constants: ["15.8", "16.0"] } };
    const high = entry("high", "ULT"), low = entry("low", "ULT");
    high.chart.constant = 16; low.chart.constant = 15.8;
    await generateConstantTablePng([{ constant: "16.0", entries: [high] }, { constant: "15.8", entries: [low] }], optionsWithGap);
    expect(texts.map(text => text.text)).toContain("16.0");
    expect(texts.map(text => text.text)).toContain("15.8");
    expect(texts.map(text => text.text)).not.toContain("15.9");
    expect(texts.some(text => text.text.includes("定数 15.8、16.0"))).toBe(true);
  });

  it("loads duplicate cover URLs once and counts missing images once", async () => {
    const entries = [entry("a", "MAS", undefined, true, "https://example.com/same.png"), entry("b", "EXP", undefined, true, "https://example.com/same.png")];
    imageMode = "error";
    const result = await generateConstantTablePng(group(entries), options());
    expect(imageUrls).toEqual(["https://example.com/same.png"]);
    expect(result.missingCovers).toBe(1);
    expect(texts.filter(text => text.text === "NO COVER")).toHaveLength(2);
  });

  it.each(["zero", "decode-error"] as const)("uses a placeholder for %s images", async mode => {
    imageMode = mode;
    const result = await generateConstantTablePng(group([entry("a", "MAS", undefined, true, "https://example.com/cover.png")]), options());
    expect(result.missingCovers).toBe(1);
    expect(texts.map(text => text.text)).toContain("NO COVER");
  });

  it("stops the whole cover queue at its deadline instead of waiting once per remaining URL", async () => {
    vi.useFakeTimers(); imageMode = "pending";
    // Stubbed window timers must use the fake clock installed above.
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const entries = Array.from({ length: 60 }, (_, index) => entry(String(index), "MAS", undefined, true, `https://example.com/${index}.png`));
    const pending = generateConstantTablePng(group(entries), options());
    await vi.advanceTimersByTimeAsync(21_000);
    const result = await pending;
    expect(result.missingCovers).toBe(60);
    expect(imageUrls.length).toBeLessThan(60);
    expect(covers()).toHaveLength(60);
  });

  it("scales oversized tables to the mobile pixel budget and keeps every entry", async () => {
    await generateConstantTablePng(group(Array.from({ length: 1000 }, (_, index) => entry(String(index)))), options(true));
    expect(scales[0]).toBeLessThan(1);
    expect(encoded[0].width * encoded[0].height).toBeLessThanOrEqual(16_000_000);
    expect(encoded[0].height).toBeLessThanOrEqual(16_000);
    expect(covers()).toHaveLength(1000);
    expect(texts.some(text => text.text.includes("全部谱面均保留"))).toBe(true);
  });

  it("refuses empty or mismatched selections before allocating a canvas", async () => {
    await expect(generateConstantTablePng(group([]), options())).rejects.toThrow("没有可导出的谱面");
    const opts = options(); opts.filters.constants = ["14.0", "14.2"];
    await expect(generateConstantTablePng(group([entry("a")]), opts)).rejects.toThrow("连续");
    await expect(generateConstantTablePng([{ constant: "15.0", entries: [entry("a")] }], options())).rejects.toThrow("超出范围");
    expect(createElement).not.toHaveBeenCalled();
  });

  it("releases the canvas after a failed encoder", async () => {
    canvas.toBlob.mockImplementation(callback => queueMicrotask(() => callback(null)));
    await expect(generateConstantTablePng(group([entry("a")]), options())).rejects.toThrow("图片生成失败");
    expect(canvas.width).toBe(0); expect(canvas.height).toBe(0);
  });
});
