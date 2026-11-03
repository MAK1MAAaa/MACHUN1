import { useState, type ReactNode } from "react";
import "./CollapsibleSection.css";

export function CollapsibleSection({ id, index, title, className, children }: {
  id: string;
  index: string;
  title: string;
  className: string;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = `${id}-content`;

  return <section className={`${className} collapsible-section${expanded ? " is-open" : ""}`} aria-labelledby={id}>
    <h2 id={id} className="collapsible-section-heading">
      <button type="button" className="collapsible-section-toggle"
        aria-label={`${expanded ? "收起" : "展开"}${title}`} aria-expanded={expanded} aria-controls={contentId}
        onClick={() => setExpanded(current => !current)}>
        <span className="collapsible-section-title"><span className="section-index">{index}</span><span>{title}</span></span>
        <span className="collapsible-section-indicator" aria-hidden="true">
          <svg viewBox="0 0 20 20"><path d="m5 7.5 5 5 5-5" /></svg>
        </span>
      </button>
    </h2>
    <div id={contentId} className="collapsible-section-content" hidden={!expanded}>{children}</div>
  </section>;
}
