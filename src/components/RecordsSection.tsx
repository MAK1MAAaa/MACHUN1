import { useEffect, useMemo, useState } from "react";
import { chartKey } from "../core/b30";
import { catalog } from "../core/catalog";
import { formatScore } from "../core/rating";
import { getSongCharts } from "../core/songDetails";
import {
  buildRecordsRows,
  clearUnavailableRecordConstant,
  cycleRecordsSort,
  EMPTY_RECORDS_FILTERS,
  getAvailableChartConstants,
  getChartLevel,
  getRecordsFilterOptions,
  paginateRecords,
  type RecordsFilters,
  type RecordsSortField,
} from "../core/recordsView";
import { SCORE_SOURCE_LABELS } from "../core/sources";
import { DIFFICULTIES, SCORE_SOURCES, type CatalogChart, type SingleRating } from "../types";
import { SongDetailsDialog } from "./SongDetailsDialog";
import { ScoreBadges } from "./ScoreBadges";
import { CollapsibleSection } from "./CollapsibleSection";
import "./RecordsSection.css";

export interface RecordsSectionProps {
  scores: Record<string, SingleRating>;
  nicknameOverrides: Record<string, string[]>;
  onEdit: (chart: CatalogChart, record?: SingleRating) => void;
  onDelete: (record: SingleRating) => void;
  onAliases?: (id: string, aliases: string[]) => Promise<void>;
  disabled: boolean;
}

export function RecordsSection({ scores, nicknameOverrides, onEdit, onDelete, onAliases, disabled }: RecordsSectionProps) {
  const [filters, setFilters] = useState<RecordsFilters>({ ...EMPTY_RECORDS_FILTERS });
  const [requestedPage, setRequestedPage] = useState(1);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [selectedChart, setSelectedChart] = useState<CatalogChart | null>(null);
  const selectedSongCharts = useMemo(() => selectedChart ? getSongCharts(selectedChart.id) : [], [selectedChart]);
  const selectedAliases = useMemo(() => selectedChart
    ? [...new Set([
      ...catalog.filter((chart) => chart.id === selectedChart.id).flatMap((chart) => chart.nickname),
      ...(nicknameOverrides[selectedChart.id] ?? []),
    ].map((alias) => alias.trim()).filter(Boolean))]
    : [], [selectedChart, nicknameOverrides]);
  const options = useMemo(() => getRecordsFilterOptions(catalog), [catalog]);
  const constantOptions = useMemo(
    () => getAvailableChartConstants(catalog, filters),
    [catalog, filters.difficulty, filters.level, filters.genre, filters.version],
  );
  const rows = useMemo(
    () => buildRecordsRows(catalog, scores, nicknameOverrides, filters),
    [scores, nicknameOverrides, filters],
  );
  const pagination = paginateRecords(rows, requestedPage);
  const activeFilterCount = [filters.difficulty, filters.level, filters.constant, filters.genre, filters.version, filters.source]
    .filter(Boolean).length + Number(filters.includeUnplayed);
  useEffect(() => {
    // Deleting the last row on a page should return to the remaining last page.
    setRequestedPage((page) => Math.min(page, pagination.pageCount));
  }, [pagination.pageCount]);

  useEffect(() => {
    if (!filters.constant || constantOptions.includes(filters.constant)) return;
    setFilters(current => clearUnavailableRecordConstant(catalog, current));
    setRequestedPage(1);
  }, [constantOptions, filters.constant]);

  function changeFilter<Key extends keyof RecordsFilters>(key: Key, value: RecordsFilters[Key]) {
    setFilters(current => clearUnavailableRecordConstant(catalog, { ...current, [key]: value }));
    setRequestedPage(1);
  }

  function sortDirection(field: RecordsSortField): "ascending" | "descending" | undefined {
    if (!filters.sort.startsWith(`${field}-`)) return undefined;
    return filters.sort.endsWith("ascending") ? "ascending" : "descending";
  }

  function renderSortButton(field: RecordsSortField, label: string) {
    const direction = sortDirection(field);
    const description = !direction ? "点击按降序排列"
      : `当前${direction === "descending" ? "降序" : "升序"}；点击改为${direction === "descending" ? "升序" : "降序"}`;
    return <button
      type="button"
      className="records-column-sort"
      aria-label={`按${label}排序`}
      aria-pressed={Boolean(direction)}
      aria-description={description}
      title={description}
      onClick={() => changeFilter("sort", cycleRecordsSort(filters.sort, field))}
    >{label}<span aria-hidden="true">{!direction ? "↕" : direction === "descending" ? "↓" : "↑"}</span></button>;
  }

  return (
    <CollapsibleSection id="records-title" index="04" title="全部成绩" className="records-section records-browser">
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
        <button
          type="button"
          className="records-filter-toggle"
          aria-label={filtersExpanded ? "收起筛选" : "展开筛选"}
          aria-description={activeFilterCount > 0 ? `已启用 ${activeFilterCount} 项筛选` : undefined}
          aria-expanded={filtersExpanded}
          aria-controls="records-advanced-filters"
          onClick={() => setFiltersExpanded((current) => !current)}
        >{filtersExpanded ? "收起筛选" : "展开筛选"}{activeFilterCount > 0 && <span className="records-filter-count">{activeFilterCount}</span>}</button>
        <div id="records-advanced-filters" className={`records-advanced-filters${filtersExpanded ? " is-expanded" : ""}`}>
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
        </div>
      </div>
      <div className="records-mobile-sort" role="group" aria-label="成绩排序">
        {renderSortButton("score", "分数")}
        {renderSortButton("rating", "Rating")}
      </div>
      <div className="record-table-wrap">
        <table className="record-table records-catalog-table">
          <caption className="records-sr-only">按曲库条件筛选的谱面</caption>
          <colgroup>
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
              <th scope="col">歌曲</th>
              <th scope="col">难度</th>
              <th scope="col">等级</th>
              <th scope="col">定数</th>
              <th scope="col">分类</th>
              <th scope="col">版本</th>
              <th scope="col">来源</th>
              <th scope="col" className="records-sort-heading" aria-sort={sortDirection("score")}>{renderSortButton("score", "分数")}</th>
              <th scope="col" className="records-sort-heading" aria-sort={sortDirection("rating")}>{renderSortButton("rating", "Rating")}</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {pagination.rows.map(({ chart, record }) => (
              <tr key={chartKey(chart)}>
                <td className="records-song-cell">
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
                <td className="records-difficulty-cell" data-label="难度"><span className={`diff-tag ${chart.difficulty.toLowerCase()}`}>{chart.difficulty}</span></td>
                <td className="records-level-cell" data-label="等级">{getChartLevel(chart.constant)}</td>
                <td className="records-constant-cell" data-label="定数">{chart.constant.toFixed(1)}</td>
                <td className="records-metadata-cell records-genre-cell" data-label="分类">{chart.genre}</td>
                <td className="records-metadata-cell records-version-cell" data-label="版本">{chart.version}</td>
                <td className="records-source-cell" data-label="来源">{record ? <span className={`score-source ${record.source}`}>{SCORE_SOURCE_LABELS[record.source]}</span> : <span className="records-unplayed">未游玩</span>}</td>
                <td className="records-score-cell" data-label="分数">{record ? <><span className="records-score-value">{formatScore(record.score)}</span><ScoreBadges record={record} /></> : "—"}</td>
                <td className="records-rating-cell" data-label="Rating">{record ? <strong className="rating-cell">{record.rating.toFixed(4)}</strong> : "—"}</td>
                <td className="records-actions-cell">
                  <div className="row-actions">
                    <button type="button" disabled={disabled} onClick={() => onEdit(chart, record)}>{record ? "修改分数" : "录入分数"}</button>
                    {record && <button type="button" className="delete" disabled={disabled} onClick={() => onDelete(record)}>删除</button>}
                  </div>
                </td>
              </tr>
            ))}
            {pagination.rows.length === 0 && <tr><td colSpan={10} className="table-empty">暂无匹配谱面，可调整筛选或显示未游玩谱面</td></tr>}
          </tbody>
        </table>
      </div>

      <nav className="records-pagination" aria-label="成绩分页">
        <span className="records-page-status records-sr-only" aria-live="polite">第 {pagination.page} / {pagination.pageCount} 页</span>
        <div className="records-page-controls">
          <button type="button" aria-label="首页" title="首页" disabled={pagination.page === 1} onClick={() => setRequestedPage(1)}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5v10m9-10-5 5 5 5" /></svg>
          </button>
          <button type="button" aria-label="上一页" title="上一页" disabled={pagination.page === 1} onClick={() => setRequestedPage(pagination.page - 1)}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12.5 5-5 5 5 5" /></svg>
          </button>
          <label className="records-page-jump">
            <span className="records-sr-only">跳转页码</span>
            <select aria-label="跳转页码" value={pagination.page} onChange={(event) => setRequestedPage(Number(event.target.value))}>
              {Array.from({ length: pagination.pageCount }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}
            </select>
            <span className="records-page-total" aria-hidden="true">/{pagination.pageCount}</span>
          </label>
          <button type="button" aria-label="下一页" title="下一页" disabled={pagination.page === pagination.pageCount} onClick={() => setRequestedPage(pagination.page + 1)}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7.5 5 5 5-5 5" /></svg>
          </button>
          <button type="button" aria-label="末页" title="末页" disabled={pagination.page === pagination.pageCount} onClick={() => setRequestedPage(pagination.pageCount)}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M15 5v10M6 5l5 5-5 5" /></svg>
          </button>
        </div>
      </nav>
      {selectedChart && <SongDetailsDialog
        chart={selectedChart}
        charts={selectedSongCharts}
        scores={scores}
        aliases={selectedAliases}
        personalAliases={nicknameOverrides[selectedChart.id] ?? []}
        onSaveAliases={onAliases ? (aliases) => onAliases(selectedChart.id, aliases) : undefined}
        onClose={() => setSelectedChart(null)}
      />}
    </CollapsibleSection>
  );
}
