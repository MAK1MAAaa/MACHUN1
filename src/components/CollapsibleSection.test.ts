import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CollapsibleSection } from "./CollapsibleSection";

describe("collapsible workspace sections", () => {
  it.each([["records-title", "04", "全部成绩"], ["constant-table-title", "05", "定数表"]])(
    "starts %s collapsed with a labelled button and retained content", (id, index, title) => {
      const html = renderToStaticMarkup(createElement(CollapsibleSection, {
        id, index, title, className: "test-section", children: createElement("input", { defaultValue: "保留筛选" }),
      }));
      expect(html).toContain(`aria-labelledby="${id}"`);
      expect(html).toContain(`<h2 id="${id}"`);
      expect(html).toContain(`aria-label="展开${title}" aria-expanded="false" aria-controls="${id}-content"`);
      expect(html).toContain(`id="${id}-content" class="collapsible-section-content" hidden=""`);
      expect(html).toContain('value="保留筛选"');
    },
  );
});
