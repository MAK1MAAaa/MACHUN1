import { scoreGrade } from "../core/rating";
import { CHAIN_LABELS, COMBO_DESCRIPTIONS, COMBO_LABELS } from "../core/scoreAchievements";
import type { SingleRating } from "../types";
import "./ScoreBadges.css";

export function ScoreBadges({ record }: { record: Pick<SingleRating, "score" | "combo" | "fullChain"> }) {
  const grade = scoreGrade(record.score);
  return (
    <span className="score-badges" aria-label="评级与达成标记">
      <span className={`score-badge score-grade${record.score >= 1_000_000 ? " score-grade-high" : ""}`} title={`评级 ${grade}`}>{grade}</span>
      {record.combo && <span className={`score-badge score-combo-${record.combo}`} title={COMBO_DESCRIPTIONS[record.combo]}>{COMBO_LABELS[record.combo]}</span>}
      {record.fullChain && <span className={`score-badge score-chain-${record.fullChain}`} title={CHAIN_LABELS[record.fullChain]}>{CHAIN_LABELS[record.fullChain]}</span>}
    </span>
  );
}
