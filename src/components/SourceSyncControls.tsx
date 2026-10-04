import { useCallback, useEffect, useRef, useState } from "react";
import { createSyncClient } from "../core/syncClient";
import type { ExternalScoreSource, SourceMergeOptions } from "../core/sources";
import { SYNC_SOURCES, type ConnectionStatus, type SourceConnection, type SyncResult } from "../syncTypes";

type PendingOperation = "bind" | "sync" | "unbind";
type Connections = Record<ExternalScoreSource, SourceConnection>;
const client = createSyncClient();

function initialConnections(): Connections {
  return Object.fromEntries(SYNC_SOURCES.map((source) => [source, {
    source, status: "unbound", bound: false, identity: null,
    lastAttemptAt: null, lastSuccessAt: null, error: null,
  }])) as Connections;
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  unbound: "未绑定", binding: "等待网页登录", ready: "已绑定", syncing: "正在同步",
  auth_required: "需要重新登录", error: "操作失败",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "本地同步请求失败";
}

export function useSourceSync(onSynced: (result: SyncResult, mergeOptions?: SourceMergeOptions) => void) {
  const [connections, setConnections] = useState(initialConnections);
  const [pending, setPending] = useState<Partial<Record<ExternalScoreSource, PendingOperation>>>({});
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<Partial<Record<ExternalScoreSource, string>>>({});
  const operations = useRef<Partial<Record<ExternalScoreSource, PendingOperation>>>({});
  const revisions = useRef<Record<ExternalScoreSource, number>>({ munet: 0, rin: 0, otogame: 0, lxns: 0 });
  const listRevision = useRef(0);
  const appliedListRevision = useRef(0);
  const syncedCallback = useRef(onSynced);
  useEffect(() => { syncedCallback.current = onSynced; }, [onSynced]);

  const refresh = useCallback(async () => {
    const requestRevision = ++listRevision.current;
    const startedRevisions = { ...revisions.current };
    try {
      const sources = await client.list();
      if (requestRevision < appliedListRevision.current) return;
      appliedListRevision.current = requestRevision;
      setConnections((current) => {
        const next = { ...current };
        for (const connection of sources) {
          if (SYNC_SOURCES.includes(connection.source) && startedRevisions[connection.source] === revisions.current[connection.source]) {
            next[connection.source] = connection;
          }
        }
        return next;
      });
      setServiceError(null);
    } catch (error) {
      if (requestRevision >= appliedListRevision.current) {
        appliedListRevision.current = requestRevision;
        setServiceError(errorText(error));
      }
    } finally {
      if (requestRevision >= appliedListRevision.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  const hasRunningTask = Object.values(connections).some((item) => item.status === "binding" || item.status === "syncing")
    || Object.keys(pending).length > 0;
  useEffect(() => {
    if (!hasRunningTask) return;
    const timer = window.setInterval(() => { void refresh(); }, 1_500);
    return () => window.clearInterval(timer);
  }, [hasRunningTask, refresh]);

  const run = async (source: ExternalScoreSource, operation: PendingOperation, token?: string, full = false, mergeOptions?: SourceMergeOptions): Promise<boolean> => {
    if (operations.current[source] && (operation !== "unbind" || operations.current[source] === "unbind")) return false;
    const connection = connections[source];
    if (operation === "sync" && (!connection.bound || connection.status === "binding" || connection.status === "syncing" || connection.status === "auth_required")) return false;
    if (operation === "bind" && (connection.status === "binding" || connection.status === "syncing")) return false;
    operations.current[source] = operation;
    const revision = ++revisions.current[source];
    setPending((current) => ({ ...current, [source]: operation }));
    setErrors((current) => ({ ...current, [source]: undefined }));
    // A request uses the merge mode chosen when it started, even if the UI changes later.
    const selectedMergeOptions = mergeOptions ? { ...mergeOptions } : undefined;
    try {
      if (operation === "sync") {
        const result = await client.sync(source, full ? { full: true } : undefined);
        if (revision !== revisions.current[source]) return false;
        syncedCallback.current(result, selectedMergeOptions);
        setConnections((current) => ({ ...current, [source]: result.connection }));
      } else {
        const next = operation === "bind" ? await client.bind(source, token) : await client.unbind(source);
        if (revision !== revisions.current[source]) return false;
        setConnections((current) => ({ ...current, [source]: next }));
      }
      setServiceError(null);
      return true;
    } catch (error) {
      if (revision === revisions.current[source]) setErrors((current) => ({ ...current, [source]: errorText(error) }));
      return false;
    } finally {
      if (revision === revisions.current[source]) {
        revisions.current[source] += 1;
        delete operations.current[source];
        setPending((current) => {
          const next = { ...current };
          delete next[source];
          return next;
        });
        void refresh();
      }
    }
  };

  return { connections, pending, serviceError, loading, errors, refresh, run };
}

type SourceSyncController = ReturnType<typeof useSourceSync>;

export function SourceSyncControls({ source, controller, mergeOptions }: { source: ExternalScoreSource; controller: SourceSyncController; mergeOptions?: SourceMergeOptions }) {
  const [token, setToken] = useState("");
  const [editingToken, setEditingToken] = useState(false);
  const connection = controller.connections[source];
  const operation = controller.pending[source];
  const running = connection.status === "binding" || connection.status === "syncing";
  const busy = Boolean(operation) || running;
  const showToken = source === "lxns" && (!connection.bound || connection.status === "auth_required" || editingToken);
  const canUnbind = connection.bound || running || Boolean(operation) || connection.status !== "unbound";
  const error = controller.errors[source] ?? connection.error;
  const status = operation === "unbind" ? "正在清除绑定" : operation === "sync" ? "正在同步" : operation === "bind" ? "正在建立绑定" : STATUS_LABEL[connection.status];

  const bind = async () => {
    if (source === "lxns" && !showToken) {
      setEditingToken(true);
      return;
    }
    if (await controller.run(source, "bind", token)) {
      setToken("");
      setEditingToken(false);
    }
  };

  return <div className="source-sync-controls">
    <div className="source-connection-heading">
      <span className={`source-connection-status ${connection.status}`} role="status">{controller.loading ? "正在读取绑定" : status}</span>
      {connection.identity && <span className="source-identity" title={connection.identity.id}>{connection.identity.label}{connection.identity.cardId ? ` · 卡 ${connection.identity.cardId}` : ""}</span>}
    </div>
    {showToken && <label className="source-token">
      <span>个人 API Token</span>
      <input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="首次绑定时填写" autoComplete="off" disabled={busy} />
    </label>}
    {connection.status === "binding" && <p className="source-sync-note">已配置 .env 时会自动登录；验证码或授权确认请在弹出窗口完成，本页会自动更新。</p>}
    {source === "otogame" && <p className="source-sync-note">首次遍历全部可用游玩历史，之后只读取新记录；仅合并当前 13.0+ 曲库中的谱面。历史位置失效时可全量校准，已有最高分保留。</p>}
    {(operation === "sync" || connection.status === "syncing") && connection.progress && <p className="source-sync-note" role="status">
      已读取 {connection.progress.completedPages} 页。
      {connection.progress.retryAt
        ? `服务器限流，将在 ${new Date(connection.progress.retryAt).toLocaleTimeString("zh-CN", { hour12: false })} 后继续。`
        : "正在同步。"}
      请保持本页和本地服务运行，完成后会自动合并成绩。
    </p>}
    <div className="source-actions source-sync-actions">
      <button type="button" disabled={busy || controller.loading || (showToken && !token.trim())} onClick={() => { void bind(); }}>
        {source === "lxns" ? (showToken ? "保存 Token" : "更换 Token") : (connection.bound || connection.status === "auth_required" ? "重新登录" : "绑定账号")}
      </button>
      <button type="button" className="primary" disabled={busy || controller.loading || !connection.bound || connection.status === "auth_required"} onClick={() => { void controller.run(source, "sync", undefined, false, mergeOptions); }}>
        {operation === "sync" || connection.status === "syncing" ? "正在同步" : "同步成绩"}
      </button>
      {source === "otogame" && connection.bound && <button type="button" disabled={busy || controller.loading || connection.status === "auth_required"} onClick={() => { void controller.run(source, "sync", undefined, true); }}>
        全量校准
      </button>}
      {canUnbind && <button type="button" className="source-unbind-button" disabled={operation === "unbind" || operation === "sync" || connection.status === "syncing" || (source === "lxns" && busy)} onClick={async () => {
        if (await controller.run(source, "unbind")) { setToken(""); setEditingToken(false); }
      }}>{connection.status === "binding" || operation === "bind" ? "取消绑定" : "解绑"}</button>}
    </div>
    <div className="source-sync-history">
      <span>最近成功：{connection.lastSuccessAt ? new Date(connection.lastSuccessAt).toLocaleString("zh-CN") : "尚未同步"}</span>
      {connection.lastAttemptAt && <span>最近尝试：{new Date(connection.lastAttemptAt).toLocaleString("zh-CN")}</span>}
    </div>
    {error && <p className="source-sync-error" role="alert">{error}</p>}
    {canUnbind && <p className="source-sync-note">解绑仅清除本机登录会话，已合并成绩保留。</p>}
  </div>;
}
