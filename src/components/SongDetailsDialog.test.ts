import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { catalog } from "../core/catalog";
import { SongDetailsDialog } from "./SongDetailsDialog";

describe("song details BPM", () => {
  it.each([
    { bpm: 180, expected: "180" },
    { bpm: 182.5, expected: "182.5" },
    { bpm: null, expected: "—" },
  ])("displays $expected for BPM $bpm without inventing missing data", ({ bpm, expected }) => {
    const chart = { ...catalog[0], bpm };
    const html = renderToStaticMarkup(createElement(SongDetailsDialog, {
      chart, charts: [chart], scores: {}, aliases: [], onClose: vi.fn(),
    }));

    expect(html).toContain(`<dt>BPM</dt><dd>${expected}</dd>`);
  });
});
