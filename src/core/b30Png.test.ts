import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SingleRating } from "../types";
import { createB30CandidatesExport, createB30Export, generateB30Png } from "./b30Export";

describe("B30 PNG generation", () => {
  const drawnText: string[] = [];
  const encodedSizes: Array<{ width: number; height: number }> = [];
  const generatedBlob = new Blob(["png"], { type: "image/png" });
  const context = new Proxy({}, {
    get(_target, property) {
      if (property === "measureText") return (text: string) => ({ width: text.length * 6 });
      if (property === "fillText") return (text: string) => { drawnText.push(text); };
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

  it("generates the original 5×6 PNG with marks and source, without starting a download", async () => {
    const data = createB30Export([makeRecord("1", "fc"), makeRecord("2", "aj")], new Map(), "test", "2026-10-13T00:00:00Z");
    const result = await generateB30Png(data);
    expect(result).toEqual({ blob: generatedBlob, filename: "machun1-b30-2026-10-13.png", missingCovers: 0 });
    expect(encodedSizes).toEqual([{ width: 2360, height: 1120 }]);
    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/png");
    expect(createElement.mock.calls).toEqual([["canvas"]]);
    expect(drawnText).toEqual(expect.arrayContaining(["FC", "AJ", "SSS+", "金 FCHAIN", "定数 14.0 · Rin服", "16.1500"]));
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it("retains the 5×10 candidate image and candidate separator dimensions", async () => {
    const data = createB30CandidatesExport([], new Map(), "test");
    const result = await generateB30Png(data);
    expect(result.filename).toMatch(/^machun1-b30-candidates20-\d{4}-\d{2}-\d{2}\.png$/);
    expect(encodedSizes).toEqual([{ width: 2360, height: 1792 }]);
    expect(drawnText.filter((text) => text === "EMPTY SLOT")).toHaveLength(50);
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
