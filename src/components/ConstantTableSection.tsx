import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { catalog } from "../core/catalog";
import { chartKey } from "../core/b30";
import {
  buildConstantTableGroups,
  CONSTANT_TABLE_AJ_COLORS,
  CONSTANT_TABLE_AJC_COLORS,
  CONSTANT_TABLE_DIFFICULTY_COLORS,
  CONSTANT_TABLE_LAMP_LABELS,
  constantTableLamp,
  DEFAULT_CONSTANT_TABLE_FILTERS,
  reconcileConstantSelection,
  validateConstantSelection,
  type ConstantTableEntry,
  type ConstantTableFilters,
} from "../core/constantTable";
import { generateConstantTablePng } from "../core/constantTableExport";
import { createDownloadResource, type DownloadResource } from "../core/fileDelivery";
import { getAvailableChartConstants, getRecordsFilterOptions } from "../core/recordsView";
import { formatScore, scoreGrade } from "../core/rating";
import type { Difficulty, SingleRating } from "../types";
import { ImageExportDialog } from "./ImageExportDialog";
import "./ConstantTableSection.css";

function copyFilters(filters: ConstantTableFilters): ConstantTableFilters {
  return { ...filters, constants: [...filters.constants] };
}

export function ConstantTableCard({ entry, showScores }: { entry: ConstantTableEntry; showScores: boolean }) {
  const { chart, record, releaseDate } = entry;
  const lamp = constantTableLamp(record);
  const title = `${chart.title} · ${chart.difficulty} ${chart.constant.toFixed(1)} · ${releaseDate ?? "上线日期未知"}`;
  return <li className={`constant-table-card difficulty-${chart.difficulty.toLowerCase()} lamp-${lamp}${showScores ? " with-score" : ""}`}
    style={{ "--constant-difficulty-color": CONSTANT_TABLE_DIFFICULTY_COLORS[chart.difficulty],
      "--constant-achievement-background": lamp === "aj" ? `linear-gradient(130deg, ${CONSTANT_TABLE_AJ_COLORS.join(", ")})`
        : lamp === "ajc" ? `linear-gradient(130deg, ${CONSTANT_TABLE_AJC_COLORS.join(", ")})` : undefined } as CSSProperties}
    title={title} aria-label={showScores ? `${title}，${record ? `${formatScore(record.score)}，${scoreGrade(record.score)}，${CONSTANT_TABLE_LAMP_LABELS[lamp]}` : "未游玩"}` : title}
    data-chart-key={chartKey(chart)} data-difficulty={chart.difficulty} data-release-date={releaseDate ?? ""}>
    <span className="constant-table-cover" aria-hidden="true">
      <span className="constant-table-cover-placeholder">NO COVER</span>
      <img src={chart.coverUrl} alt="" crossOrigin="anonymous" loading="lazy" onError={(event) => { event.currentTarget.style.opacity = "0"; }} />
    </span>
    {showScores && <span className="constant-table-score-panel">
      <strong className="constant-table-score">{record ? formatScore(record.score) : "—"}</strong>
      <span className="constant-table-grade">{record ? scoreGrade(record.score) : "—"}</span>
      <span className="constant-table-lamp">{CONSTANT_TABLE_LAMP_LABELS[lamp]}</span>
    </span>}
  </li>;
}

export function ConstantTableSection({ scores }: { scores: Record<string, SingleRating> }) {
  const [filters, setFilters] = useState<ConstantTableFilters>(() => copyFilters(DEFAULT_CONSTANT_TABLE_FILTERS));
  const [generatedFilters, setGeneratedFilters] = useState<ConstantTableFilters>(() => copyFilters(DEFAULT_CONSTANT_TABLE_FILTERS));
  const [showScores, setShowScores] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [imageExport, setImageExport] = useState<{ file: DownloadResource; missingCovers: number; previewAlt: string } | null>(null);
  const imageExportRef = useRef<DownloadResource | null>(null);
  const generation = useRef({ version: 0, running: false });
  const options = useMemo(() => getRecordsFilterOptions(catalog), [catalog]);
  const constantOptions = useMemo(() => getAvailableChartConstants(catalog, filters),
    [catalog, filters.difficulty, filters.level, filters.genre, filters.version]);
  const pendingChanges = JSON.stringify(filters) !== JSON.stringify(generatedFilters);
  const selectionValid = useMemo(() => {
    try { validateConstantSelection(filters.constants, constantOptions); return true; } catch { return false; }
  }, [filters.constants, constantOptions]);
  const groups = useMemo(() => buildConstantTableGroups(catalog, scores, generatedFilters), [scores, generatedFilters]);
  const chartCount = groups.reduce((total, group) => total + group.entries.length, 0);

  useEffect(() => () => {
    generation.current.version++;
    generation.current.running = false;
    imageExportRef.current?.dispose();
    imageExportRef.current = null;
  }, []);

  useEffect(() => {
    setFilters(current => {
      const constants = reconcileConstantSelection(current.constants, getAvailableChartConstants(catalog, current));
      return JSON.stringify(constants) === JSON.stringify(current.constants) ? current : { ...current, constants };
    });
  }, [constantOptions]);

  function changeFilter<Key extends keyof ConstantTableFilters>(key: Key, value: ConstantTableFilters[Key]) {
    setFilters(current => {
      const next = { ...current, [key]: value };
      next.constants = reconcileConstantSelection(next.constants, getAvailableChartConstants(catalog, next));
      return next;
    });
    setSelectionError(null); setExportError(null);
  }

  function generate() {
    try {
      const constants = validateConstantSelection(filters.constants, constantOptions);
      setGeneratedFilters({ ...filters, constants });
      setSelectionError(null); setExportError(null);
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : "请检查定数选择。");
    }
  }

  function closeImageExport() {
    imageExportRef.current?.dispose();
    imageExportRef.current = null; setImageExport(null);
  }

  async function exportImage() {
    if (generation.current.running || pendingChanges || !selectionValid || !chartCount) return;
    generation.current.running = true;
    const version = ++generation.current.version;
    setExporting(true); setExportError(null);
    try {
      const result = await generateConstantTablePng(groups, { showScores, filters: generatedFilters });
      if (version !== generation.current.version) return;
      const file = createDownloadResource(result.blob, result.filename);
      imageExportRef.current?.dispose(); imageExportRef.current = file;
      setImageExport({ file, missingCovers: result.missingCovers, previewAlt: showScores
        ? "定数表，按定数与难度分组，显示封面、分数、评级及 CLEAR、FULL COMBO、ALL JUSTICE、AJC 状态"
        : "定数表，按定数与难度分组显示带难度色框的歌曲封面" });
    } catch (error) {
      if (version === generation.current.version) setExportError(error instanceof Error ? error.message : "定数表图片生成失败，请重试。");
    } finally {
      if (version === generation.current.version) { generation.current.running = false; setExporting(false); }
    }
  }

  return <section className="constant-table-section" aria-labelledby="constant-table-title">
    <div className="section-heading constant-table-heading">
      <div><span className="section-index">05</span><h2 id="constant-table-title">定数表</h2></div>
    </div>
    <div className="constant-table-filters" aria-label="定数表筛选">
      <label><span>难度</span><select aria-label="定数表难度" value={filters.difficulty} disabled={exporting}
        onChange={event => changeFilter("difficulty", event.target.value as Difficulty | "")}>
        <option value="">全部难度</option><option value="ULT">ULT 黑谱</option><option value="MAS">MAS 紫谱</option><option value="EXP">EXP 红谱</option>
      </select></label>
      <label><span>等级</span><select aria-label="定数表等级" value={filters.level} disabled={exporting} onChange={event => changeFilter("level", event.target.value)}>
        <option value="">全部等级</option>{options.levels.map(level => <option key={level} value={level}>{level}</option>)}
      </select></label>
      <label><span>定数</span><select aria-label="定数表定数" value={filters.constants[0] ?? ""} disabled={exporting}
        onChange={event => changeFilter("constants", event.target.value ? [event.target.value] : [])}>
        <option value="">选择定数</option>{constantOptions.map(constant => <option key={constant} value={constant}>{constant}</option>)}
      </select></label>
      <label><span>分类</span><select aria-label="定数表分类" value={filters.genre} disabled={exporting} onChange={event => changeFilter("genre", event.target.value)}>
        <option value="">全部分类</option>{options.genres.map(genre => <option key={genre} value={genre}>{genre}</option>)}
      </select></label>
      <label><span>版本</span><select aria-label="定数表版本" value={filters.version} disabled={exporting} onChange={event => changeFilter("version", event.target.value)}>
        <option value="">全部版本</option>{options.versions.map(version => <option key={version} value={version}>{version}</option>)}
      </select></label>
    </div>
    {selectionError && <p className="constant-table-error" role="alert">{selectionError}</p>}
    <div className="constant-table-actions">
      <button type="button" className="constant-table-generate" onClick={generate} disabled={exporting || !selectionValid}>生成定数表</button>
      <button type="button" aria-pressed={showScores} disabled={exporting} onClick={() => setShowScores(value => !value)}>显示成绩</button>
      <button type="button" onClick={() => { void exportImage(); }} disabled={exporting || pendingChanges || !selectionValid || chartCount === 0}>{exporting ? "正在生成定数表图片" : "导出定数表 PNG"}</button>
    </div>
    {exportError && <p className="constant-table-error" role="alert">{exportError}</p>}
    <div className={`constant-table-results${showScores ? " show-scores" : ""}`} aria-label="定数表结果" aria-busy={exporting}>
      {chartCount === 0 && <p className="constant-table-empty">当前生成条件下没有可显示的谱面。</p>}
      {groups.map(group => <div key={group.constant} className="constant-table-group" data-constant={group.constant}>
        <h3><strong>{group.constant}</strong><span>{group.entries.length} 张</span></h3>
        {group.entries.length > 0 ? <ol className="constant-table-grid" aria-label={`${group.constant} 定数谱面`}>
          {group.entries.map(entry => <ConstantTableCard key={chartKey(entry.chart)} entry={entry} showScores={showScores} />)}
        </ol> : <p className="constant-table-empty">此定数下没有符合筛选条件的谱面。</p>}
      </div>)}
    </div>
    {imageExport && <ImageExportDialog file={imageExport.file} label="定数表" missingCovers={imageExport.missingCovers} previewAlt={imageExport.previewAlt} onClose={closeImageExport} />}
  </section>;
}
