import {
  type ChangeEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CatalogChart, ScoreSource, SingleRating } from "./types";
import { B30_SIZE, chartKey, compareRatings, getB30, getB30Summary, getB30Axis } from "./core/b30";
import { CATALOG_DATE, CATALOG_VERSION, catalog, catalogByKey } from "./core/catalog";
import { createB30Export, createB30CandidatesExport, downloadB30Json, downloadB30Png } from "./core/b30Export";
import { formatScore } from "./core/rating";
import type { Account, WorkspaceSnapshot } from "./accountTypes";
import { useAccountWorkspace } from "./components/useAccountWorkspace";
import { createFullBackup, downloadFullBackup } from "./core/backup";
import { SourceSyncControls, useSourceSync } from "./components/SourceSyncControls";
import { RecordsSection } from "./components/RecordsSection";
import { ScoreBadges } from "./components/ScoreBadges";
import {
  SCORE_SOURCE_LABELS,
  type ExternalScoreSource,
  type SourceImportReport,
  type SourceMergeOptions,
} from "./core/sources";

type NoticeKind = "success" | "warning" | "error";

interface Notice {
  kind: NoticeKind;
  text: string;
}

interface SourceHelpContent {
  title: string;
  subtitle: string;
  steps: string[];
  format: string;
  caution: string;
  documentationUrl: string;
  documentationLabel: string;
}

const SOURCE_HELP: Record<ExternalScoreSource, SourceHelpContent> = {
  munet: {
    title: "MuNET 同步与导入",
    subtitle: "通过本地后台保存网页登录会话，按需同步 CHUNITHM 最高分。",
    steps: [
      "使用 pnpm start 启动本地服务，点击 MuNET 卡片中的“绑定账号”。",
      "在本机弹出的独立浏览器窗口完成登录，等待卡片显示绑定身份。",
      "点击“同步成绩”；以后可以直接同步，会话失效时重新登录。",
      "也可导出 MuNET CHUNITHM 存档，再点击“选择 MuNET JSON 文件”离线导入。",
    ],
    format: "支持 userMusicDetailList 中的 musicId、level、scoreMax；难度 2 / 3 / 4 对应 EXP / MAS / ULT。若包含 gameId，必须为 SDHD。仅匹配当前 13.0+ 曲库。",
    caution: "MuNET 同步或文件导入仅在分数严格高于已有国服成绩时覆盖；同分和较低分保留国服成绩及来源。网页登录会话保存在本机后台。解绑会清除会话，但不会删除已合并成绩；文件导入由后台解析并保存到当前账号。",
    documentationUrl: "https://github.com/MuNET-OSS/chunithm-data-converter",
    documentationLabel: "查看 MuNET 兼容格式参考",
  },
  rin: {
    title: "Rin服同步与导入",
    subtitle: "在 Rin 门户完成登录，由本地后台记住会话并同步已绑定卡片的成绩。",
    steps: [
      "点击“绑定账号”，在本机弹出的 Rin 门户窗口完成登录。",
      "首次绑定前确认门户默认 Aime 卡是目标卡；绑定完成后在卡片中核对账号和卡号。",
      "点击“同步成绩”，后台使用已绑定卡片导出成绩，不修改门户默认卡。",
      "离线导入时，在 Rin 门户依次进入“中二节奏 → 设定 → 导出玩家存档”。",
      "点击“选择 Rin JSON 文件”，导入 chusan_*_exported.json。",
    ],
    format: "优先支持 Rin 完整 chusan_*_exported.json：userMusicDetailList[].musicId、level、scoreMax；同时兼容 old/new Rating 响应。",
    caution: "导出文件可能包含成绩以外的账号数据，请只在本机使用，不要将原始文件公开分享。",
    documentationUrl: "https://portal.naominet.live/",
    documentationLabel: "打开 Rin 门户",
  },
  otogame: {
    title: "大饼同步与导入",
    subtitle: "首次遍历游玩历史建立成绩缓存，之后只读取新的历史记录。",
    steps: [
      "点击“绑定账号”，在本机弹出的独立大饼窗口用已关联的 BEMANICN 账号登录。",
      "等待显示绑定身份后，点击“同步成绩”。",
      "首次读取当前主卡的全部可用游玩历史并提取最高分；以后只读取上次同步位置之后的新历史。",
      "历史位置失效时点击“全量校准”；首次历史遍历和校准可能需要等待限流，期间保持页面与服务运行。",
      "也可在大饼“CHUNiTHM → 乐曲信息 → Rating对象曲”的网络请求中保存 rating 响应为 oto.json。",
      "点击“选择大饼 JSON 文件”即可离线导入。",
    ],
    format: "支持 data.*_rating_list[].music.name、difficulty、score，同时兼容常见 Rating/Record JSON 字段。",
    caution: "后台使用独立的本机浏览器会话；请勿把 BEMANICN 密码、令牌或 Cookie 写入成绩 JSON。",
    documentationUrl: "https://u.otogame.net/",
    documentationLabel: "打开大饼",
  },
  lxns: {
    title: "国服 · 落雪同步方法",
    subtitle: "将落雪个人 API Token 绑定到本地后台，以后可直接同步成绩。",
    steps: [
      "导出文件方法：登录落雪咖啡屋，依次进入“中二节奏 → 成绩管理 → 备份成绩 → 导出成绩”。",
      "下载 chunithm-scores.csv 后，回到本工具点击“选择落雪 CSV / JSON”并选择该文件。",
      "API 方法：在落雪账号详情中生成个人 API 密钥，它不是开发者 API Key。",
      "将个人 API Token 粘贴到输入框，点击“保存 Token”，绑定成功后输入框会清空。",
      "点击“同步成绩”；以后无需再次输入 Token，默认只合并更高分。",
      "若曾将国服成绩误导入 MuNET，可启用“国服覆盖 MuNET”后重新同步或导入国服文件。同谱面的 MuNET 记录会被国服记录替换，同分和较低分也可修正；其他来源仍按最高分合并，未匹配的 MuNET 记录保留。",
    ],
    format: "支持 chunithm-scores.csv 的 id、level_index、score、upload_time 列，以及落雪标准 success/code/data JSON。仅保留定数 13.0 以上谱面。",
    caution: "Token 由本地后台保存，不写入浏览器成绩存储或导出文件；解绑会清除本机保存的 Token。",
    documentationUrl: "https://maimai.lxns.net/docs/developer-guide",
    documentationLabel: "查看个人 API 文档",
  },
};

const difficultyLabel: Record<CatalogChart["difficulty"], string> = {
  EXP: "EXPERT",
  MAS: "MASTER",
  ULT: "ULTIMA",
};

function CoverImage({ src, className = "" }: { src: string; className?: string }) {
  return (
    <span className={`cover-image ${className}`} aria-hidden="true">
      <img
        src={src}
        alt=""
        crossOrigin="anonymous"
        loading="lazy"
        onError={(event) => { event.currentTarget.style.opacity = "0"; }}
      />
    </span>
  );
}

function SourceTag({ source }: { source: ScoreSource }) {
  return <span className={`score-source ${source}`}>{SCORE_SOURCE_LABELS[source]}</span>;
}

function sourceReportText(report: SourceImportReport): string {
  const changed = report.importedScores + report.updatedScores;
  const corrected = report.replacedMunetScores ? `，其中覆盖 MuNET ${report.replacedMunetScores} 条` : "";
  return `已写入 ${changed} 条（新增 ${report.importedScores}、更新 ${report.updatedScores}）${corrected}，跳过 ${report.skippedScores + report.unknownCharts + report.invalidEntries} 条`;
}

interface AppProps {
  account: Account;
  initial: WorkspaceSnapshot;
  initialNotice?: string;
}

function App({ account, initial, initialNotice }: AppProps) {
  const workspace = useAccountWorkspace(initial);
  const localState = workspace.snapshot.state;
  const [notice, setNotice] = useState<Notice | null>(initialNotice ? { kind: "warning", text: initialNotice } : null);
  const [editing, setEditing] = useState<{ key: string; title: string; difficulty: string; score: string; isNew: boolean } | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const editDialogRef = useRef<HTMLDialogElement>(null);
  const [b30ImagesOpen, setB30ImagesOpen] = useState(false);
  const [localToolsOpen, setLocalToolsOpen] = useState(false);
  const [sourceToolsOpen, setSourceToolsOpen] = useState(false);
  const [exportingImage, setExportingImage] = useState(false);
  const [pendingSource, setPendingSource] = useState<{ source: ExternalScoreSource; mergeOptions?: SourceMergeOptions } | null>(null);
  const [nationalRepairEnabled, setNationalRepairEnabled] = useState(false);
  const [helpSource, setHelpSource] = useState<ExternalScoreSource | null>(null);
  const sourceFileInputRef = useRef<HTMLInputElement>(null);
  const backupInputRef = useRef<HTMLInputElement>(null);
  const [backupMode, setBackupMode] = useState<"merge" | "replace">("merge");
  const sourceSync = useSourceSync((result) => {
    if (!result.workspace) throw new Error("同步未返回已保存的工作区，请更新本地服务后重试。");
    workspace.apply(result.workspace);
    setNotice({ kind: result.report.invalidEntries + result.report.unknownCharts > 0 ? "warning" : "success",
      text: `${SCORE_SOURCE_LABELS[result.source]}同步完成：${sourceReportText(result.report)}` });
  });
  const nationalRepairBusy = Boolean(sourceSync.pending.lxns)
    || sourceSync.connections.lxns.status === "syncing" || sourceSync.connections.lxns.status === "binding";

  useEffect(() => {
    if (editing && !editDialogRef.current?.open) editDialogRef.current?.showModal();
    if (!editing) editDialogRef.current?.close();
  }, [editing]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 4_000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (!helpSource) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setHelpSource(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [helpSource]);

  const records = useMemo(
    () => Object.values(localState.scores)
      .filter((record) => catalogByKey.has(chartKey(record)))
      .sort(compareRatings),
    [localState.scores],
  );
  const b30 = useMemo(() => getB30(records), [records]);
  const summary = useMemo(() => getB30Summary(records), [records]);
  const b30Analysis = useMemo(() => {
    const axis = getB30Axis(b30);
    const rating = Math.floor(summary.average * 100 + 1e-8) / 100;
    const ratingPosition = ((rating - axis.min) / axis.span) * 100;
    const difficultyCounts = b30.reduce(
      (counts, record) => ({ ...counts, [record.difficulty]: counts[record.difficulty] + 1 }),
      { EXP: 0, MAS: 0, ULT: 0 },
    );
    return {
      scaleMax: axis.max,
      scaleMin: axis.min,
      scaleRating: rating,
      ratingPosition,
      showRatingGuide: ratingPosition >= 0 && ratingPosition <= 100,
      scaleSpan: axis.span,
      difficultyCounts,
    };
  }, [b30, summary.average]);
  const deleteRecord = async (record: SingleRating) => {
    if (!window.confirm(`确认删除《${record.title}》${record.difficulty} 的成绩？`)) return;
    try {
      const result = await workspace.action({ type: "delete", key: chartKey(record) });
      setNotice({ kind: "success", text: result.notice ?? "成绩已删除" });
    } catch { /* Workspace banner retains the error and current data. */ }
  };

  const exportB30Json = (withCandidates = false) => {
    try {
      downloadB30Json(records, withCandidates);
      const filename = withCandidates ? "b30-candidates20.json" : "b30.json";
      setNotice({ kind: "success", text: `${filename} 已导出，可通过大饼 JSON 入口导入` });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "B30 JSON 导出失败" });
    }
  };

  const exportB30Image = async (withCandidates = false) => {
    if (exportingImage) return;
    setExportingImage(true);
    const imageLabel = withCandidates ? "B30 + 候选20" : "B30";
    setNotice({ kind: "success", text: "正在加载曲绘并生成 B30 图片" });
    try {
      const result = await downloadB30Png(
        withCandidates
          ? createB30CandidatesExport(records, catalogByKey, CATALOG_VERSION)
          : createB30Export(records, catalogByKey, CATALOG_VERSION),
      );
      setNotice({
        kind: result.missingCovers > 0 ? "warning" : "success",
        text: result.missingCovers > 0
          ? `${imageLabel} 图片已导出，${result.missingCovers} 张曲绘加载失败并使用占位图`
          : `${imageLabel} PNG 图片已导出`,
      });
    } catch (error) {
      setNotice({
        kind: "error",
        text: error instanceof Error ? error.message : "B30 图片导出失败",
      });
    } finally {
      setExportingImage(false);
    }
  };

  const openSourceImport = (source: ExternalScoreSource) => {
    setPendingSource({ source, mergeOptions: source === "lxns" && nationalRepairEnabled ? { overwriteMunet: true } : undefined });
    sourceFileInputRef.current?.click();
  };

  const handleSourceImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !pendingSource) return;
    const { source, mergeOptions } = pendingSource;
    if (file.size > 10 * 1024 * 1024) {
      setNotice({ kind: "error", text: "导入文件不能超过 10 MB" });
      return;
    }
    try {
      const raw = await file.text();
      const result = await workspace.action({ type: "import", source, raw, filename: file.name, mergeOptions });
      setNotice({ kind: result.report && result.report.invalidEntries + result.report.unknownCharts > 0 ? "warning" : "success",
        text: result.report ? `${SCORE_SOURCE_LABELS[source]}导入完成：${sourceReportText(result.report)}` : result.notice ?? "导入完成" });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "来源数据导入失败" });
    }
  };

  const resetAllData = async () => {
    if (!window.confirm("确认清空当前账号的全部成绩和个人别名？此操作无法撤销。")) return;
    try {
      const result = await workspace.action({ type: "clear" });
      setNotice({ kind: "success", text: result.notice ?? "账号数据已清空" });
    } catch { /* Do not clear data before the database confirms the operation. */ }
  };

  const handleBackupImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setNotice({ kind: "error", text: "备份不能超过 10 MB" }); return; }
    if (backupMode === "replace" && !window.confirm("确认用备份替换当前账号的全部成绩和个人别名？")) return;
    try {
      const result = await workspace.action({ type: "backup", raw: await file.text(), mode: backupMode });
      setNotice({ kind: "success", text: result.notice ?? "备份导入完成" });
    } catch (error) { setNotice({ kind: "error", text: error instanceof Error ? error.message : "备份导入失败" }); }
  };

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="brand-block">
          <span className="eyebrow">MACHUN1 RATING WORKSPACE</span>
          <h1>MACHUN<span>1</span></h1>
          <p>按账号保存和同步各来源成绩，自动计算单曲 Rating。</p>
          <div className="hero-tags" aria-label="工具特性">
            <span>USER WORKSPACE</span>
            <span>13.0+ CHARTS</span>
            <span>BEST 30 ONLY</span>
          </div>
        </div>
        <div className="catalog-stamp" aria-label="曲库版本">
          <span>MATE SNAPSHOT</span>
          <strong>{CATALOG_DATE.replaceAll("-", ".")}</strong>
          <small>{catalog.length.toLocaleString("zh-CN")} CHARTS</small>
        </div>
      </header>

      {workspace.error && (
        <div className="status-banner error" role="alert">
          <div>
            <strong>数据库请求失败</strong>
            <span>{workspace.error} 当前页面数据保留。</span>
          </div>
          <button type="button" onClick={() => { void workspace.reload(); }}>重新读取</button>
        </div>
      )}

      {notice && <div className={`toast ${notice.kind}`} role="status">{notice.text}</div>}

      <main>
        <section className="summary-grid" aria-label="B30 汇总">
          <article className="summary-card primary">
            <span>B30 RATING</span>
            <strong>{summary.average.toFixed(4)}</strong>
            <small>固定除以 30，空位计 0</small>
          </article>
          <article className="summary-card">
            <span>已填槽位</span>
            <strong>{summary.count}<i>/30</i></strong>
            <small>{Math.round((summary.count / B30_SIZE) * 100)}% COMPLETE</small>
          </article>
          <article className="summary-card">
            <span>账号成绩</span>
            <strong>{records.length}</strong>
            <small>UNIQUE CHARTS</small>
          </article>
          <a
            className="summary-card import-shortcut"
            href="#score-sources"
            onClick={() => setSourceToolsOpen(true)}
          >
            <span>服务器成绩</span>
            <strong>同步</strong>
            <small>RIN / 大饼 / 国服 / MuNET</small>
          </a>
        </section>

        <section className={`local-tools-section ${localToolsOpen ? "open" : ""}`}>
          <button
            type="button"
            className="local-tools-toggle"
            aria-expanded={localToolsOpen}
            onClick={() => setLocalToolsOpen((open) => !open)}
          >
            <span><b>01</b><strong>账号数据</strong></span>
            <span>{localToolsOpen ? "完全折叠" : "展开工具"}<i aria-hidden="true">{localToolsOpen ? "−" : "+"}</i></span>
          </button>

          {localToolsOpen && <aside className="panel data-panel">
            <div className="panel-heading compact">
              <div>
                <span className="section-index">01</span>
                <h2>账号数据</h2>
              </div>
            </div>
            <div className="privacy-note">
              <strong>{account.username}</strong>
              <p>成绩和个人别名保存在 MySQL，来源绑定仅供当前账号使用。完整备份包含成绩、来源和达成标记，不包含登录信息。</p>
            </div>
            <div className="data-divider" />
            <dl className="catalog-meta">
              <div><dt>曲库</dt><dd>{CATALOG_VERSION}</dd></div>
              <div><dt>谱面数</dt><dd>{catalog.length.toLocaleString("zh-CN")}</dd></div>
              <div><dt>范围</dt><dd>13.0 — 16.0</dd></div>
              <div><dt>类型</dt><dd>EXP / MAS / ULT</dd></div>
            </dl>
            <div className="backup-tools">
              <button type="button" onClick={() => { downloadFullBackup(createFullBackup(localState, CATALOG_VERSION)); }}>导出完整备份</button>
              <label>导入方式 <select aria-label="备份导入方式" value={backupMode} onChange={event => setBackupMode(event.target.value as "merge" | "replace")}><option value="merge">合并最高分</option><option value="replace">替换全部</option></select></label>
              <button type="button" disabled={workspace.busy} onClick={() => backupInputRef.current?.click()}>导入完整备份</button>
              <input ref={backupInputRef} type="file" accept=".json,application/json" hidden onChange={event => { void handleBackupImport(event); }} />
            </div>
            <button type="button" className="danger-action" disabled={workspace.busy} onClick={() => { void resetAllData(); }}>清空当前账号数据</button>
          </aside>}
        </section>

        <section
          className={`source-tools-section ${sourceToolsOpen ? "open" : ""}`}
          id="score-sources"
        >
          <button
            type="button"
            className="source-tools-toggle"
            aria-expanded={sourceToolsOpen}
            aria-controls="source-tools-content"
            onClick={() => setSourceToolsOpen((open) => !open)}
          >
            <span>
              <b>02</b>
              <strong>成绩来源</strong>
              <small>Rin服 / 大饼 / 国服 · 落雪 / MuNET</small>
            </span>
            <span>{sourceToolsOpen ? "完全折叠" : "展开来源"}<i aria-hidden="true">{sourceToolsOpen ? "−" : "+"}</i></span>
          </button>

          {sourceToolsOpen && <div className="source-section" id="source-tools-content">
            <div className="section-heading">
              <div>
                <span className="section-index">02</span>
                <h2>服务器成绩同步</h2>
              </div>
              <p>只合并更高分；定数与 Rating 始终按当前离线曲库重算</p>
            </div>
            {sourceSync.serviceError && <div className="source-service-error" role="alert">
              <p>{sourceSync.serviceError}</p>
              <button type="button" onClick={() => { void sourceSync.refresh(); }}>重新连接</button>
            </div>}
            <div className="source-grid">
            <article className="source-card munet">
              <div className="source-card-heading">
                <div>
                  <span className="source-badge">CHUNITHM SAVE DATA</span>
                  <h3>MuNET</h3>
                </div>
                <div className="source-card-tools">
                  <SourceTag source="munet" />
                  <button
                    type="button"
                    className="source-help-button"
                    aria-label="查看 MuNET 导入帮助"
                    title="导入帮助"
                    onClick={() => setHelpSource("munet")}
                  >?</button>
                </div>
              </div>
              <p>在独立窗口登录 MuNET，本机后台记住会话；点击同步以更新谱面最高分。</p>
              <SourceSyncControls source="munet" controller={sourceSync} />
              <p className="source-sync-note">MuNET 分数严格高于已有国服成绩时才会覆盖；同分和较低分保留国服成绩及来源。</p>
              <div className="source-actions">
                <button type="button" className="source-import-button" onClick={() => openSourceImport("munet")}>选择 MuNET JSON 文件</button>
              </div>
            </article>

            <article className="source-card rin">
              <div className="source-card-heading">
                <div>
                  <span className="source-badge">BEMANICN</span>
                  <h3>Rin服</h3>
                </div>
                <div className="source-card-tools">
                  <SourceTag source="rin" />
                  <button
                    type="button"
                    className="source-help-button"
                    aria-label="查看 Rin服导入帮助"
                    title="导入帮助"
                    onClick={() => setHelpSource("rin")}
                  >?</button>
                </div>
              </div>
              <p>登录 Rin 后绑定当前卡片，后续按该卡同步完整谱面最高分记录。</p>
              <SourceSyncControls source="rin" controller={sourceSync} />
              <div className="source-actions">
                <button type="button" className="source-import-button" onClick={() => openSourceImport("rin")}>选择 Rin JSON 文件</button>
                <a href="https://portal.naominet.live/" target="_blank" rel="noreferrer">打开 Rin 门户</a>
              </div>
            </article>

            <article className="source-card otogame">
              <div className="source-card-heading">
                <div>
                  <span className="source-badge">BEMANICN</span>
                  <h3>大饼</h3>
                </div>
                <div className="source-card-tools">
                  <SourceTag source="otogame" />
                  <button
                    type="button"
                    className="source-help-button"
                    aria-label="查看大饼导入帮助"
                    title="导入帮助"
                    onClick={() => setHelpSource("otogame")}
                  >?</button>
                </div>
              </div>
              <p>读取绑定主卡的游玩历史，提取 EXP／MAS／ULT 最高分并关联当前离线曲库。</p>
              <SourceSyncControls source="otogame" controller={sourceSync} />
              <div className="source-actions">
                <button type="button" className="source-import-button" onClick={() => openSourceImport("otogame")}>选择大饼 JSON 文件</button>
                <a href="https://u.otogame.net/" target="_blank" rel="noreferrer">打开大饼</a>
              </div>
            </article>

            <article className="source-card lxns">
              <div className="source-card-heading">
                <div>
                  <span className="source-badge">PERSONAL API</span>
                  <h3>国服 · 落雪</h3>
                </div>
                <div className="source-card-tools">
                  <SourceTag source="lxns" />
                  <button
                    type="button"
                    className="source-help-button"
                    aria-label="查看国服落雪同步帮助"
                    title="导入帮助"
                    onClick={() => setHelpSource("lxns")}
                  >?</button>
                </div>
              </div>
              <p>首次保存个人 API Token 到本机后台，以后可直接同步，也可离线导入成绩文件。</p>
              <div className="source-repair-controls">
                <button type="button" className="source-repair-toggle" aria-pressed={nationalRepairEnabled} disabled={nationalRepairBusy} onClick={() => setNationalRepairEnabled((enabled) => !enabled)}>
                  国服覆盖 MuNET
                </button>
                <p className="source-sync-note">{nationalRepairEnabled
                  ? "已启用：国服同步或文件导入将替换同谱面的 MuNET 记录，同分和较低分也会覆盖。其他来源仍按最高分合并，未匹配的 MuNET 记录保留。"
                  : "曾把国服成绩误导入 MuNET 时，可启用此模式后重新同步或导入国服文件；默认仅合并更高分。"}</p>
              </div>
              <SourceSyncControls source="lxns" controller={sourceSync} mergeOptions={nationalRepairEnabled ? { overwriteMunet: true } : undefined} />
              <div className="source-actions split">
                <button type="button" className="source-import-button" onClick={() => openSourceImport("lxns")}>选择落雪 CSV / JSON</button>
                <a href="https://maimai.lxns.net/docs/api/chunithm" target="_blank" rel="noreferrer">API 文档</a>
              </div>
            </article>
            </div>
          </div>}
          <input
            ref={sourceFileInputRef}
            type="file"
            accept="application/json,text/csv,.json,.csv"
            hidden
            onChange={handleSourceImport}
          />
        </section>

        <section className="b30-section">
          <div className="section-heading">
            <div>
              <span className="section-index">03</span>
              <h2>BEST 30</h2>
            </div>
            <div className="b30-heading-tools">
              <p>按单曲 Rating 自动排序 · 同一谱面只占一个位置</p>
              <div className="b30-export-actions">
                <button type="button" onClick={() => exportB30Json()}>导出 B30 JSON</button>
                <button type="button" onClick={() => exportB30Json(true)}>导出 B30 + 候选20 JSON</button>
                <button type="button" className="primary" onClick={() => exportB30Image()} disabled={exportingImage}>
                  {exportingImage ? "正在生成图片" : "导出 B30 图片"}
                </button>
                <button type="button" onClick={() => exportB30Image(true)} disabled={exportingImage}>
                  导出 B30 + 候选20 图片
                </button>
              </div>
            </div>
          </div>
          <div className="b30-analysis" aria-label="B30 Rating 柱状分析">
            <div className="b30-analysis-heading">
              <div>
                <span>RATING PROFILE</span>
                <h3>B30 柱状分析</h3>
              </div>
              <div className="difficulty-legend" aria-label="难度颜色图例">
                <span className="exp"><i />EXPERT</span>
                <span className="mas"><i />MASTER</span>
                <span className="ult"><i />ULTIMA</span>
              </div>
            </div>
            <div className="analysis-metrics">
              <div><span>上界 · B1 + 0.2 向下取整</span><strong>{b30Analysis.scaleMax.toFixed(1)}</strong></div>
              <div>
                <span>下界 · {b30.length === B30_SIZE ? "B30" : "当前末位"} − 0.2 向上取整</span>
                <strong>{b30Analysis.scaleMin.toFixed(1)}</strong>
              </div>
              <div><span>Rating · 向下取整</span><strong>{b30Analysis.scaleRating.toFixed(2)}</strong></div>
              <div>
                <span>难度分布</span>
                <strong className="difficulty-counts">
                  <i className="exp">{b30Analysis.difficultyCounts.EXP}</i>
                  <i className="mas">{b30Analysis.difficultyCounts.MAS}</i>
                  <i className="ult">{b30Analysis.difficultyCounts.ULT}</i>
                </strong>
              </div>
            </div>
            <div className="b30-chart-scroll">
              <div className="b30-chart-plot">
                <div className="b30-chart-scale" aria-hidden="true">
                  <div className="b30-chart-scale-values">
                    <span className="b30-scale-upper-label">{b30Analysis.scaleMax.toFixed(1)}</span>
                    {b30Analysis.showRatingGuide && <span className="b30-scale-rating-label" style={{ bottom: `${b30Analysis.ratingPosition}%` }}>{b30Analysis.scaleRating.toFixed(2)}</span>}
                    <span className="b30-scale-lower-label">{b30Analysis.scaleMin.toFixed(1)}</span>
                  </div>
                </div>
                <div className="b30-bars" role="list" aria-label="按排名排列的 B30 单曲 Rating">
                  <div className="b30-chart-guides" aria-hidden="true">
                    <span className="b30-chart-upper-line" />
                    {b30Analysis.showRatingGuide && <span className="b30-chart-rating-line" style={{ bottom: `${b30Analysis.ratingPosition}%` }} />}
                  </div>
                  {Array.from({ length: B30_SIZE }, (_, index) => {
                    const record = b30[index];
                    const barHeight = record
                      ? ((record.rating - b30Analysis.scaleMin) / b30Analysis.scaleSpan) * 100
                      : 0;
                    return (
                      <div
                        className={`b30-bar-item ${record ? record.difficulty.toLowerCase() : "empty"}`}
                        key={record ? `analysis-${chartKey(record)}` : `analysis-empty-${index}`}
                        role="listitem"
                        title={record ? `${record.title} · ${record.rating.toFixed(4)}` : `第 ${index + 1} 位为空`}
                        aria-label={record
                          ? `第 ${index + 1} 位，${record.title}，${difficultyLabel[record.difficulty]}，Rating ${record.rating.toFixed(4)}`
                          : `第 ${index + 1} 位，空槽`}
                      >
                        <div className="b30-bar-track">
                          {record ? (
                            <div className="b30-bar-column" style={{ height: `${Math.min(barHeight, 100)}%` }}>
                              <span className="b30-bar-tooltip">{record.rating.toFixed(4)}<small>{record.title}</small><ScoreBadges record={record} /></span>
                            </div>
                          ) : <div className="b30-bar-empty-mark" />}
                        </div>
                        <span className="b30-bar-rank">{String(index + 1).padStart(2, "0")}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
          <button type="button" className="b30-preview-toggle" aria-expanded={b30ImagesOpen} aria-controls="b30-image-preview" onClick={() => setB30ImagesOpen((open) => !open)}>
            {b30ImagesOpen ? "收起 B30 图片" : "展开 B30 图片"}
          </button>
          {b30ImagesOpen && <div id="b30-image-preview" className="b30-table-scroll">
            <div className="b30-grid">
              {Array.from({ length: B30_SIZE }, (_, index) => {
                const record = b30[index];
                return record ? (
                  <article className={`b30-card ${record.difficulty.toLowerCase()}`} key={chartKey(record)}>
                    <div className="card-rank">#{String(index + 1).padStart(2, "0")}</div>
                    <CoverImage
                      src={catalogByKey.get(chartKey(record))?.coverUrl ?? ""}
                      className="card-cover"
                    />
                    <div className="card-content">
                      <div className="card-title">
                        <div className="card-chart-meta">
                          <span>{difficultyLabel[record.difficulty]}</span>
                          <span>定数 <strong>{record.constant.toFixed(1)}</strong></span>
                          <SourceTag source={record.source} />
                        </div>
                        <h3 title={record.title}>{record.title}</h3>
                        <ScoreBadges record={record} />
                      </div>
                      <div className="card-stats">
                        <div><span>分数</span><strong>{formatScore(record.score)}</strong></div>
                        <div><span>单曲 RATING</span><strong>{record.rating.toFixed(4)}</strong></div>
                      </div>
                    </div>
                  </article>
                ) : (
                  <article className="b30-card empty" key={`empty-${index}`}>
                    <div className="card-rank">#{String(index + 1).padStart(2, "0")}</div>
                    <div className="empty-mark">EMPTY SLOT</div>
                  </article>
                );
              })}
            </div>
          </div>}
        </section>

        <RecordsSection
          records={records}
          scores={localState.scores}
          nicknameOverrides={localState.nicknameOverrides}
          disabled={workspace.busy}
          onEdit={(chart, record) => {
            setEditError(null);
            setEditing({ key: chartKey(chart), title: chart.title, difficulty: chart.difficulty, score: record ? String(record.score) : "", isNew: !record });
          }}
          onDelete={deleteRecord}
          onAliases={async (id, aliases) => { await workspace.action({ type: "aliases", id, aliases }); }}
        />
      </main>

      <footer>
        <span>UNOFFICIAL FAN TOOL</span>
        <p>曲库与曲绘 URL 参考 OTOGE DB 社区数据。本工具与 SEGA CORPORATION 无关。</p>
      </footer>

      <dialog ref={editDialogRef} className="modal score-edit-dialog" aria-labelledby="score-edit-title" onCancel={() => setEditing(null)}>
        {editing && <form onSubmit={async (event) => {
          event.preventDefault();
          if (workspace.busy) return;
          try {
            const result = await workspace.action({ type: "manual", key: editing.key, score: editing.score });
            setEditing(null);
            setNotice({ kind: "success", text: result.notice ?? "分数已更新，来源标记为神秘游客" });
          } catch (error) {
            setEditError(error instanceof Error ? error.message : "修改失败");
          }
        }}>
          <h2 id="score-edit-title">{editing.isNew ? "录入分数" : "修改分数"}</h2>
          <p>{editing.title} · {editing.difficulty}</p>
          <label className="field-group">
            <span>分数</span>
            <input autoFocus inputMode="numeric" value={editing.score}
              aria-invalid={Boolean(editError)} aria-describedby="score-edit-note"
              onChange={(event) => { setEditing({ ...editing, score: event.target.value }); setEditError(null); }} />
          </label>
          <p id="score-edit-note">保存会覆盖当前分数（包括降低分数），自动重算 Rating，来源显示为“神秘游客”。</p>
          {editError && <p className="score-edit-error" role="alert">{editError}</p>}
          <div className="modal-actions">
            <button type="button" onClick={() => setEditing(null)}>取消</button>
            <button type="submit" className="confirm" disabled={workspace.busy}>保存修改</button>
          </div>
        </form>}
      </dialog>

      {helpSource && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setHelpSource(null)}>
          <div
            className="modal source-help-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="source-help-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="source-help-heading">
              <div>
                <span className="modal-kicker">IMPORT GUIDE</span>
                <h2 id="source-help-title">{SOURCE_HELP[helpSource].title}</h2>
              </div>
              <button type="button" aria-label="关闭帮助" onClick={() => setHelpSource(null)}>关闭</button>
            </div>
            <p className="source-help-intro">{SOURCE_HELP[helpSource].subtitle}</p>
            <ol className="source-help-steps">
              {SOURCE_HELP[helpSource].steps.map((step) => <li key={step}>{step}</li>)}
            </ol>
            <dl className="source-help-details">
              <div>
                <dt>支持格式</dt>
                <dd>{SOURCE_HELP[helpSource].format}</dd>
              </div>
              <div className="caution">
                <dt>安全提示</dt>
                <dd>{SOURCE_HELP[helpSource].caution}</dd>
              </div>
            </dl>
            <div className="source-help-actions">
              <a
                href={SOURCE_HELP[helpSource].documentationUrl}
                target="_blank"
                rel="noreferrer"
              >{SOURCE_HELP[helpSource].documentationLabel}</a>
              <button type="button" onClick={() => setHelpSource(null)}>我知道了</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default App;
