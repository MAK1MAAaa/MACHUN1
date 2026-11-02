import { scoreGrade, formatScore } from "../core/rating";
import { CLEAR_LABELS, COMBO_DESCRIPTIONS, CHAIN_LABELS } from "../core/scoreAchievements";
import { SCORE_SOURCE_LABELS } from "../core/sources";
import type { Difficulty, SingleRating } from "../types";
import "./B30ScoreCard.css";

const DIFFICULTY_NAMES: Record<Difficulty, string> = {
  EXP: "EXPERT", MAS: "MASTER", ULT: "ULTIMA",
};

export function B30ScoreCard({ record, rank, coverUrl = "" }: {
  record?: SingleRating;
  rank: number;
  coverUrl?: string;
}) {
  const rankText = `#${String(rank).padStart(2, "0")}`;
  if (!record) return <article className="b30-card score-card empty" aria-label={`第 ${rank} 位，空位`}>
    <span className="score-card-rank">{rankText}</span>
    <span className="empty-mark">EMPTY SLOT</span>
  </article>;

  const lamp = record.combo ? COMBO_DESCRIPTIONS[record.combo] : record.clear ? CLEAR_LABELS[record.clear] : "—";
  const lampKind = record.combo ?? record.clear ?? "unknown";
  const grade = scoreGrade(record.score);

  return <article className={`b30-card score-card ${record.difficulty.toLowerCase()}`}>
    <header className="score-card-topline">
      <div className="score-card-tags">
        <span className={`score-card-source source-${record.source}`} title={`成绩来源：${SCORE_SOURCE_LABELS[record.source]}`}>{SCORE_SOURCE_LABELS[record.source]}</span>
        {record.fullChain && <span className="score-card-chain" title={CHAIN_LABELS[record.fullChain]}>{CHAIN_LABELS[record.fullChain]}</span>}
      </div>
      <span className="score-card-rank">{rankText}</span>
    </header>
    <div className="score-card-artwork" aria-hidden="true">
      <span>NO COVER</span>
      {coverUrl && <img key={coverUrl} src={coverUrl} alt="" crossOrigin="anonymous" loading="lazy"
        onError={(event) => { event.currentTarget.style.opacity = "0"; }} />}
    </div>
    <div className="score-card-content">
      <h3 className="score-card-title" title={record.title}>{record.title}</h3>
      <strong className="score-card-score" aria-label={`分数 ${formatScore(record.score)}`}>{formatScore(record.score)}</strong>
      <div className="score-card-chart-meta">
        <span>{DIFFICULTY_NAMES[record.difficulty]} {record.constant.toFixed(1)}</span>
        <span className="score-card-rating">Rating: {record.rating.toFixed(4)}</span>
      </div>
    </div>
    <footer className="score-card-footer">
      <span className={`score-card-lamp lamp-${lampKind}`} title={lamp === "—" ? "CLEAR 状态未知" : lamp} aria-label={`达成状态：${lamp}`}>{lamp}</span>
      <span className={`score-card-grade${record.score >= 1_000_000 ? " grade-high" : ""}`} aria-label={`评级 ${grade}`}>{grade}</span>
    </footer>
  </article>;
}
