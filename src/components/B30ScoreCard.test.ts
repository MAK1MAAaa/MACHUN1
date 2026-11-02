import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SingleRating } from "../types";
import { B30ScoreCard } from "./B30ScoreCard";

const record: SingleRating = {
  id: "demo", title: "The Devil Incarnate", difficulty: "EXP", constant: 14.1,
  score: 1_009_761, rating: 16.25, updatedAt: "2026-11-01T00:00:00Z", source: "rin",
};

describe("B30 score card", () => {
  it("keeps source and rank above the score, with full achievements and grade in the footer", () => {
    const html = renderToStaticMarkup(createElement(B30ScoreCard, { record: { ...record, combo: "aj", fullChain: "platinum", clear: "absolute" }, rank: 21 }));
    expect(html).toContain("score-card-source source-rin");
    expect(html).toContain(">Rin服</span>");
    expect(html).toContain(">#21</span>");
    expect(html.indexOf("score-card-source")).toBeLessThan(html.indexOf("score-card-score"));
    expect(html.indexOf("score-card-score")).toBeLessThan(html.indexOf("score-card-footer"));
    expect(html).toContain("1,009,761");
    expect(html).toContain("EXPERT 14.1");
    expect(html).toContain("Rating: 16.2500");
    expect(html).toContain("ALL JUSTICE");
    expect(html).toContain("SSS+");
    expect(html).toContain("铂 FCHAIN");
    expect(html).not.toContain(">ABSOLUTE</span>");
  });

  it.each(["failed", "clear", "hard", "brave", "absolute", "catastrophy"] as const)("uses the explicit %s clear state without a combo lamp", (clear) => {
    const html = renderToStaticMarkup(createElement(B30ScoreCard, { record: { ...record, clear }, rank: 1 }));
    expect(html).toContain(`lamp-${clear}`);
    expect(html).toContain(`>${clear.toUpperCase()}</span>`);
  });

  it("does not infer CLEAR from a high score and leaves missing state unknown", () => {
    const html = renderToStaticMarkup(createElement(B30ScoreCard, { record, rank: 2 }));
    expect(html).toContain("lamp-unknown");
    expect(html).toContain("CLEAR 状态未知");
    expect(html).toContain('aria-label="达成状态：—"');
    expect(html).not.toContain(">CLEAR</span>");
  });

  it.each([["fc", "FULL COMBO"], ["ajc", "ALL JUSTICE CRITICAL"]] as const)("preserves %s precedence over CLEAR", (combo, text) => {
    const html = renderToStaticMarkup(createElement(B30ScoreCard, { record: { ...record, combo, clear: "catastrophy" }, rank: 3 }));
    expect(html).toContain(text);
    expect(html).not.toContain(">CATASTROPHY</span>");
  });

  it("keeps empty slots as empty ranks rather than fabricated scores", () => {
    const html = renderToStaticMarkup(createElement(B30ScoreCard, { rank: 30 }));
    expect(html).toContain("EMPTY SLOT");
    expect(html).toContain("#30");
    expect(html).not.toContain("score-card-score");
    expect(html).not.toContain("score-card-footer");
  });
});
