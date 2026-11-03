import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { catalog } from "../core/catalog";
import type { ConstantTableEntry } from "../core/constantTable";
import type { SingleRating } from "../types";
import { ConstantTableCard, ConstantTableSection } from "./ConstantTableSection";

const chart = catalog.find(entry => entry.difficulty === "MAS")!;
const record: SingleRating = {
  id: chart.id, title: chart.title, difficulty: chart.difficulty, constant: chart.constant,
  score: 1_009_123, rating: 17, source: "rin", updatedAt: "2026-11-01T00:00:00Z",
};
const entry: ConstantTableEntry = { chart, record, releaseDate: "2026-04-23" };
function card(value: ConstantTableEntry, showScores = false): string {
  return renderToStaticMarkup(createElement(ConstantTableCard, { entry: value, showScores }));
}

describe("constant table cards", () => {
  it("shows only the square cover and difficulty border until scores are enabled", () => {
    const html = card(entry);
    expect(html).toContain('class="constant-table-cover"');
    expect(html).toContain("--constant-difficulty-color:#8b4bb7");
    expect(html).toContain(`src="${chart.coverUrl}"`);
    expect(html).toContain("2026-04-23");
    expect(html).not.toContain('class="constant-table-score-panel"');
    expect(html).not.toContain("1,009,123");
    expect(html).not.toContain(`>${chart.title}<`);
  });

  it.each([["ULT", "#26212e"], ["MAS", "#8b4bb7"], ["EXP", "#dd2636"]] as const)("uses the semantic border for %s", (difficulty, color) => {
    expect(card({ ...entry, chart: { ...chart, difficulty } })).toContain(`--constant-difficulty-color:${color}`);
  });

  it.each(["fc", "aj", "ajc"] as const)("retains the %s lamp and score in the rectangle", combo => {
    const html = card({ ...entry, record: { ...record, combo } }, true);
    expect(html).toContain(`lamp-${combo} with-score`);
    expect(html).toContain('class="constant-table-score">1,009,123</strong>');
    expect(html).toContain('class="constant-table-grade">SSS+</span>');
    expect(html).toContain(`class="constant-table-lamp">${{ fc: "FULL COMBO", aj: "ALL JUSTICE", ajc: "AJC" }[combo]}</span>`);
  });

  it("uses the default CLEAR visual group for played scores without combo", () => {
    const html = card(entry, true);
    expect(html).toContain("lamp-clear with-score");
    expect(html).toContain('class="constant-table-lamp">CLEAR</span>');
  });

  it("keeps unplayed charts distinct from zero scores or CLEAR", () => {
    const html = card({ ...entry, record: undefined, releaseDate: null }, true);
    expect(html).toContain("lamp-unplayed with-score");
    expect(html).toContain("上线日期未知");
    expect(html).toContain('class="constant-table-score">—</strong>');
    expect(html).toContain('class="constant-table-lamp">未游玩</span>');
    expect(html).not.toContain(">CLEAR</span>");
    expect(html).not.toContain(">D</span>");
  });
});

describe("constant table section", () => {
  it("starts with a generated 14.0 cover table and five ordered single-select filters", () => {
    const html = renderToStaticMarkup(createElement(ConstantTableSection, { scores: {} }));
    const selects = [...html.matchAll(/<select\b[^>]*aria-label="([^"]*)"[^>]*>[\s\S]*?<\/select>/g)];
    expect(selects.map(match => match[1])).toEqual(["定数表难度", "定数表等级", "定数表定数", "定数表分类", "定数表版本"]);
    const constantSelect = selects[2][0];
    expect(constantSelect).toContain('<option value="">选择定数</option>');
    expect(constantSelect).toContain('<option value="14.0" selected="">14.0</option>');
    expect(constantSelect).not.toContain("multiple");
    expect(html).toContain('data-constant="14.0"');
    expect(html.match(/class="constant-table-card /g)).toHaveLength(catalog.filter(chart => chart.constant === 14).length);
    expect(html).toContain('aria-pressed="false">显示成绩</button>');
    expect(html).not.toContain("constant-table-score-panel");
    expect(html.indexOf('value="ULT"')).toBeLessThan(html.indexOf('value="MAS"'));
    expect(html.indexOf('value="MAS"')).toBeLessThan(html.indexOf('value="EXP"'));
    expect(html).not.toContain("<fieldset");
    expect(html).not.toContain("constant-table-constant-picker");
    expect(html).not.toContain("constant-table-result-count");
    expect(html).not.toContain("constant-table-pending");
    expect(html).not.toContain("筛选已修改");
    expect(html).not.toContain("最多连续 5 档");
    expect(html).not.toContain("清空定数");
  });
});
