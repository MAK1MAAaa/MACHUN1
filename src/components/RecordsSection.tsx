import { useEffect, useMemo, useState } from "react";
import { chartKey } from "../core/b30";
import { catalog } from "../core/catalog";
import { formatScore } from "../core/rating";
import { getSongCharts } from "../core/songDetails";
import {
  buildRecordsRows,
  EMPTY_RECORDS_FILTERS,
  getChartLevel,
  getRecordsFilterOptions,
  paginateRecords,
  RECORDS_PAGE_SIZE,
  type RecordsFilters,
  type RecordsViewMode,
} from "../core/recordsView";
import { SCORE_SOURCE_LABELS } from "../core/sources";
import { DIFFICULTIES, SCORE_SOURCES, type CatalogChart, type SingleRating } from "../types";
import { SongDetailsDialog } from "./SongDetailsDialog";
import { ScoreBadges } from "./ScoreBadges";
import "./RecordsSection.css";

export interface RecordsSectionProps {
  records: SingleRating[];
  scores: Record<string, SingleRating>;
  nicknameOverrides: Record<string, string[]>;
  onEdit: (chart: CatalogChart, record?: SingleRating) => void;
  onDelete: (record: SingleRating) => void;
  disabled: boolean;
}

export function RecordsSection({ records, scores, nicknameOverrides, onEdit, onDelete, disabled }: RecordsSectionProps) {
  const [mode, setMode] = useState<RecordsViewMode>("rating");
  const [filters, setFilters] = useState<RecordsFilters>({ ...EMPTY_RECORDS_FILTERS });
  const [requestedPage, setRequestedPage] = useState(1);
  const [selectedChart, setSelectedChart] = useState<CatalogChart | null>(null);
  const selectedSongCharts = useMemo(() => selectedChart ? getSongCharts(selectedChart.id) : [], [selectedChart]);
  const selectedAliases = useMemo(() => selectedChart
    ? [...new Set([
      ...catalog.filter((chart) => chart.id === selectedChart.id).flatMap((chart) => chart.nickname),
      ...(nicknameOverrides[selectedChart.id] ?? []),
    ].map((alias) => alias.trim()).filter(Boolean))]
    : [], [selectedChart, nicknameOverrides]);
  const options = useMemo(() => getRecordsFilterOptions(catalog), []);
  const constantOptions = useMemo(
    () => options.constants.filter((constant) => !filters.level || getChartLevel(Number(constant)) === filters.level),
    [options.constants, filters.level],
  );
  const rows = useMemo(
    () => buildRecordsRows(catalog, records, scores, nicknameOverrides, mode, filters),
    [records, scores, nicknameOverrides, mode, filters],
  );
  const pagination = paginateRecords(rows, requestedPage);
  useEffect(() => {
    // Deleting the last row on a page should return to the remaining last page.
    setRequestedPage((page) => Math.min(page, pagination.pageCount));
  }, [pagination.pageCount]);

  function changeFilter<Key extends keyof RecordsFilters>(key: Key, value: RecordsFilters[Key]) {
    setFilters((current) => {
      const next = { ...current, [key]: value };
      if (key === "level" && next.level && next.constant && getChartLevel(Number(next.constant)) !== next.level) {
        next.constant = "";
      }
      return next;
    });
    setRequestedPage(1);
  }

  function changeMode(nextMode: RecordsViewMode) {
    setMode(nextMode);
    setRequestedPage(1);
  }

  function cycleScoreSort() {
    changeFilter("scoreSort", filters.scoreSort === "default" ? "descending" : filters.scoreSort === "descending" ? "ascending" : "default");
  }

  return (
    <section className="records-section records-browser" aria-labelledby="records-title">
      <div className="section-heading records-heading">
        <div>
          <span className="section-index">04</span>
          <h2 id="records-title">全部成绩</h2>
        </div>
      </div>

      <div className="records-toolbar">
        <div className="records-mode" role="group" aria-label="成绩浏览方式">
          <button type="button" aria-pressed={mode === "rating"} onClick={() => changeMode("rating")}>Rating 排名</button>
          <button type="button" aria-pressed={mode === "catalog"} onClick={() => changeMode("catalog")}>曲库筛选</button>
        </div>
        <span className="records-count" aria-live="polite">共 {pagination.total} 项 · 每页 {RECORDS_PAGE_SIZE} 项</span>
      </div>

      <div className="records-filters" aria-label="成绩筛选">
        <label className="record-search records-filter-search">
          <span>搜索</span>
          <input
            type="search"
            aria-label="搜索"
            value={filters.query}
            onChange={(event) => changeFilter("query", event.target.value)}
            placeholder="曲名、别名、ID 或难度"
          />
        </label>
        {mode === "catalog" && <>
          <label className="records-filter">
            <span>难度</span>
            <select aria-label="难度" value={filters.difficulty} onChange={(event) => changeFilter("difficulty", event.target.value as RecordsFilters["difficulty"])}>
              <option value="">全部难度</option>
              {DIFFICULTIES.map((difficulty) => <option key={difficulty} value={difficulty}>{difficulty}</option>)}
            </select>
          </label>
          <label className="records-filter">
            <span>等级</span>
            <select aria-label="等级" value={filters.level} onChange={(event) => changeFilter("level", event.target.value)}>
              <option value="">全部等级</option>
              {options.levels.map((level) => <option key={level} value={level}>{level}</option>)}
            </select>
          </label>
          <label className="records-filter">
            <span>定数</span>
            <select aria-label="定数" value={filters.constant} onChange={(event) => changeFilter("constant", event.target.value)}>
              <option value="">全部定数</option>
              {constantOptions.map((constant) => <option key={constant} value={constant}>{constant}</option>)}
            </select>
          </label>
          <label className="records-filter records-genre-filter">
            <span>分类</span>
            <select aria-label="分类" value={filters.genre} onChange={(event) => changeFilter("genre", event.target.value)}>
              <option value="">全部分类</option>
              {options.genres.map((genre) => <option key={genre} value={genre}>{genre}</option>)}
            </select>
          </label>
          <label className="records-filter records-version-filter">
            <span>版本</span>
            <select aria-label="版本" value={filters.version} onChange={(event) => changeFilter("version", event.target.value)}>
              <option value="">全部版本</option>
              {options.versions.map((version) => <option key={version} value={version}>{version}</option>)}
            </select>
          </label>
          <label className="records-filter records-source-filter">
            <span>来源</span>
            <select aria-label="成绩来源" value={filters.source} onChange={(event) => changeFilter("source", event.target.value as RecordsFilters["source"])}>
              <option value="">全部来源</option>
              {SCORE_SOURCES.map((source) => <option key={source} value={source}>{SCORE_SOURCE_LABELS[source]}</option>)}
            </select>
          </label>
          <div className="records-filter-actions">
            <button
              type="button"
              className="records-unplayed-toggle"
              aria-pressed={filters.includeUnplayed}
              disabled={filters.source !== ""}
              title={filters.source ? "选择全部来源后可显示未游玩谱面" : undefined}
              onClick={() => changeFilter("includeUnplayed", !filters.includeUnplayed)}
            >显示未游玩谱面</button>
            <button type="button" className="records-reset" onClick={() => { setFilters({ ...EMPTY_RECORDS_FILTERS }); setRequestedPage(1); }}>清除筛选</button>
          </div>
        </>}
      </div>
      <div className="record-table-wrap">
        <table className={`record-table records-${mode}-table`}>
          <caption className="records-sr-only">{mode === "rating" ? "按 Rating 排序的已有成绩" : "按曲库条件筛选的谱面"}</caption>
          <colgroup>
            {mode === "rating" && <col className="records-col-rank" />}
            <col className="records-col-song" />
            <col className="records-col-difficulty" />
            <col className="records-col-level" />
            <col className="records-col-constant" />
            <col className="records-col-genre" />
            <col className="records-col-version" />
            <col className="records-col-source" />
            <col className="records-col-score" />
            <col className="records-col-rating" />
            <col className="records-col-actions" />
          </colgroup>
          <thead>
            <tr>
              {mode === "rating" && <th scope="col">排名</th>}
              <th scope="col">歌曲</th>
              <th scope="col">难度</th>
              <th scope="col">等级</th>
              <th scope="col">定数</th>
              <th scope="col">分类</th>
              <th scope="col">版本</th>
              <th scope="col">来源</th>
              <th scope="col" aria-sort={mode === "catalog" ? (filters.scoreSort === "default" ? "none" : filters.scoreSort) : undefined}>
                {mode === "catalog" ? (
                  <button
                    type="button"
                    className="records-score-sort"
                    aria-label="按分数排序"
                    title={filters.scoreSort === "default" ? "当前按定数排序；点击按分数从高到低排序" : filters.scoreSort === "descending" ? "当前分数从高到低；点击从低到高排序" : "当前分数从低到高；点击恢复按定数排序"}
                    onClick={cycleScoreSort}
                  >分数 <span aria-hidden="true">{filters.scoreSort === "default" ? "↕" : filters.scoreSort === "descending" ? "↓" : "↑"}</span></button>
                ) : "分数"}
              </th>
              <th scope="col">Rating</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {pagination.rows.map(({ chart, record, rank }) => (
              <tr key={chartKey(chart)}>
                {mode === "rating" && <td><span className={rank !== null && rank <= 30 ? "in-b30" : ""}>#{rank}</span></td>}
                <td>
                  <div className="record-song-cell">
                    <span className="cover-image record-cover" aria-hidden="true">
                      <img src={chart.coverUrl} alt="" crossOrigin="anonymous" loading="lazy" onError={(event) => { event.currentTarget.style.opacity = "0"; }} />
                    </span>
                    <span className="record-song-info">
                      <button
                        type="button"
                        className="record-title-details"
                        title={chart.title}
                        aria-label={`查看歌曲详情：${chart.title}`}
                        aria-haspopup="dialog"
                        onClick={() => setSelectedChart(chart)}
                      >{chart.title}</button>
                      <small>ID {chart.id}</small>
                    </span>
                  </div>
                </td>
                <td><span className={`diff-tag ${chart.difficulty.toLowerCase()}`}>{chart.difficulty}</span></td>
                <td>{getChartLevel(chart.constant)}</td>
                <td>{chart.constant.toFixed(1)}</td>
                <td className="records-metadata-cell">{chart.genre}</td>
                <td className="records-metadata-cell">{chart.version}</td>
                <td>{record ? <span className={`score-source ${record.source}`}>{SCORE_SOURCE_LABELS[record.source]}</span> : <span className="records-unplayed">未游玩</span>}</td>
                <td className="records-score-cell">{record ? <>{formatScore(record.score)}<ScoreBadges record={record} /></> : "—"}</td>
                <td>{record ? <strong className="rating-cell">{record.rating.toFixed(4)}</strong> : "—"}</td>
                <td>
                  <div className="row-actions">
                    <button type="button" disabled={disabled} onClick={() => onEdit(chart, record)}>{record ? "修改分数" : "录入分数"}</button>
                    {record && <button type="button" className="delete" disabled={disabled} onClick={() => onDelete(record)}>删除</button>}
                  </div>
                </td>
              </tr>
            ))}
            {pagination.rows.length === 0 && <tr><td colSpan={mode === "rating" ? 11 : 10} className="table-empty">{mode === "rating" ? "暂无匹配成绩" : "暂无匹配谱面，可调整筛选或显示未游玩谱面"}</td></tr>}
          </tbody>
        </table>
      </div>

      {mode === "catalog" && <p className="records-source-note">来源按当前最高成绩的归属筛选{filters.source ? "，仅显示所选来源的已游玩谱面" : "；未游玩谱面没有来源"}。</p>}

      <nav className="records-pagination" aria-label="成绩分页">
        <span className="records-page-status" aria-live="polite">第 {pagination.page} / {pagination.pageCount} 页</span>
        <div className="records-page-controls">
          <button type="button" disabled={pagination.page === 1} onClick={() => setRequestedPage(1)}>首页</button>
          <button type="button" disabled={pagination.page === 1} onClick={() => setRequestedPage(pagination.page - 1)}>上一页</button>
          <label className="records-page-jump">
            <span className="records-sr-only">跳转页码</span>
            <select aria-label="跳转页码" value={pagination.page} onChange={(event) => setRequestedPage(Number(event.target.value))}>
              {Array.from({ length: pagination.pageCount }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}
            </select>
          </label>
          <button type="button" disabled={pagination.page === pagination.pageCount} onClick={() => setRequestedPage(pagination.page + 1)}>下一页</button>
          <button type="button" disabled={pagination.page === pagination.pageCount} onClick={() => setRequestedPage(pagination.pageCount)}>末页</button>
        </div>
      </nav>
      {selectedChart && <SongDetailsDialog
        chart={selectedChart}
        charts={selectedSongCharts}
        scores={scores}
        aliases={selectedAliases}
        onClose={() => setSelectedChart(null)}
      />}
    </section>
  );
}
