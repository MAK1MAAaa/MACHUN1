import { ScoreBadges } from './ScoreBadges';

export function RecordRow({ title, id, difficulty, constant, score, rating, combo }) {
  return <tr><td><strong>{title}</strong><small>ID {id}</small></td><td><span className={`diff-tag ${difficulty.toLowerCase()}`}>{difficulty}</span></td><td className="numeric">{constant.toFixed(1)}</td><td className="numeric">{score.toLocaleString('en-US')}<ScoreBadges grade="SSS+" combo={combo} /></td><td className="numeric">{rating.toFixed(4)}</td><td><button type="button" className="secondary">修改分数</button></td></tr>;
}
