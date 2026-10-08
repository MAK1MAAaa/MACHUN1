import { useEffect, useId, useRef, useState } from "react";
import { chartKey } from "../core/b30";
import { formatScore } from "../core/rating";
import { DIFFICULTIES, type CatalogChart, type SingleRating } from "../types";
import { ScoreBadges } from "./ScoreBadges";
import "./SongDetailsDialog.css";

export interface SongDetailsDialogProps {
  chart: CatalogChart;
  charts: readonly Pick<CatalogChart, "id" | "difficulty" | "constant">[];
  scores: Record<string, SingleRating>;
  aliases: readonly string[];
  personalAliases?: readonly string[];
  onSaveAliases?: (aliases: string[]) => Promise<void>;
  onClose: () => void;
}

export function SongDetailsDialog({ chart, charts, scores, aliases, personalAliases = [], onSaveAliases, onClose }: SongDetailsDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [aliasText, setAliasText] = useState(personalAliases.join("\n"));
  const [saving, setSaving] = useState(false);
  const [aliasNotice, setAliasNotice] = useState<string | null>(null);
  const uniqueAliases = [...new Set(aliases.map((alias) => alias.trim()).filter(Boolean))];

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousOverflow = document.body.style.overflow;
    if (!dialog.open) dialog.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      if (dialog.open) dialog.close();
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="song-details-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
          onClose();
        }
      }}
    >
      <button type="button" className="song-details-close" aria-label="关闭歌曲详情" onClick={onClose} autoFocus>
        <span aria-hidden="true">×</span>
      </button>

      <header className="song-details-heading">
        <span className="cover-image song-details-cover" aria-hidden="true">
          <img key={chart.coverUrl} src={chart.coverUrl} alt="" onError={(event) => { event.currentTarget.style.opacity = "0"; }} />
        </span>
        <div className="song-details-title-group">
          <span className="song-details-id">{chart.id}</span>
          <h2 id={titleId}>{chart.title}</h2>
        </div>
      </header>

      <dl className="song-details-metadata">
        <div><dt>类别</dt><dd>{chart.genre || "—"}</dd></div>
        <div><dt>添加版本</dt><dd>{chart.version || "—"}</dd></div>
      </dl>

      <ul className="song-details-charts" aria-label="谱面定数与成绩">
        {DIFFICULTIES.map((difficulty) => {
          const songChart = charts.find((candidate) => candidate.id === chart.id && candidate.difficulty === difficulty);
          const record = scores[chartKey({ id: chart.id, difficulty })];
          return (
            <li key={difficulty} className={`song-details-chart song-details-${difficulty.toLowerCase()}`}>
              <span className="song-details-difficulty">{difficulty}</span>
              <span className="song-details-constant" aria-label={`${difficulty} 定数`}>{songChart ? songChart.constant.toFixed(1) : "/"}</span>
              <span className="song-details-score" aria-label={`${difficulty} 成绩`}>
                {record && <>{formatScore(record.score)}<ScoreBadges record={record} /></>}
              </span>
            </li>
          );
        })}
      </ul>

      <section className="song-details-aliases" aria-label="歌曲别名">
        <h3>歌曲别名</h3>
        {uniqueAliases.length ? (
          <ul>{uniqueAliases.map((alias) => <li key={alias}>{alias}</li>)}</ul>
        ) : <p>暂无别名</p>}
        {onSaveAliases && <form className="personal-alias-form" onSubmit={async event => {
          event.preventDefault(); if (saving) return;
          setSaving(true); setAliasNotice(null);
          try { await onSaveAliases(aliasText.split("\n")); setAliasNotice("个人别名已保存。"); }
          catch (error) { setAliasNotice(error instanceof Error ? error.message : "别名保存失败。"); }
          finally { setSaving(false); }
        }}>
          <label>个人别名（每行一个）<textarea aria-label="个人别名" rows={3} value={aliasText} onChange={event => setAliasText(event.target.value)} /></label>
          <button type="submit" disabled={saving}>{saving ? "正在保存…" : "保存个人别名"}</button>
          {aliasNotice && <p role="status">{aliasNotice}</p>}
        </form>}
      </section>
    </dialog>
  );
}
