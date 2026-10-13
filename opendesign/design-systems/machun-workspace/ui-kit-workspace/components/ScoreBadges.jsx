export function ScoreBadges({ grade, combo }) {
  return <span className="score-badges" aria-label="评级与达成标记"><span className="score-badge score-grade-high">{grade}</span>{combo && <span className={`score-badge score-combo-${combo.toLowerCase()}`}>{combo}</span>}</span>;
}
