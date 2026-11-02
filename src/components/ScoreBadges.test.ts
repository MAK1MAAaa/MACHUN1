import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CLEAR_LABELS } from "../core/scoreAchievements";
import type { ClearStatus } from "../types";
import { ScoreBadges } from "./ScoreBadges";

describe("score clear badges", () => {
  it.each(Object.keys(CLEAR_LABELS) as ClearStatus[])("displays explicit %s when no combo lamp exists", (clear) => {
    const html = renderToStaticMarkup(createElement(ScoreBadges, { record: { score: 1_000_000, clear } }));
    expect(html).toContain(`score-clear-${clear}`);
    expect(html).toContain(`>${CLEAR_LABELS[clear]}</span>`);
    expect(html).toContain(">SS</span>");
  });

  it("gives combo lamps precedence while retaining chain and grade", () => {
    const html = renderToStaticMarkup(createElement(ScoreBadges, {
      record: { score: 1_009_000, combo: "aj", clear: "absolute", fullChain: "gold" },
    }));
    expect(html).toContain("score-combo-aj");
    expect(html).not.toContain("score-clear-");
    expect(html).toContain("score-chain-gold");
    expect(html).toContain(">SSS+</span>");
  });

  it("does not infer a clear lamp from an unmarked high score", () => {
    const html = renderToStaticMarkup(createElement(ScoreBadges, { record: { score: 1_009_000 } }));
    expect(html).not.toContain("score-clear-");
  });
});
