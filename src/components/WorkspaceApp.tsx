import { useEffect, useState } from 'react';
import App from '../App';
import type { WorkspaceSnapshot } from '../accountTypes';
import { workspaceClient } from '../core/workspaceClient';
import { installCatalogSnapshot } from '../core/catalog';
import { installSongChartDetails } from '../core/songDetails';
import { loadLocalState } from '../core/storage';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; workspace: WorkspaceSnapshot; notice?: string }
  | { status: 'error'; message: string };

export function WorkspaceApp() {
  const [loaded, setLoaded] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    async function loadWorkspace() {
      try {
        const [snapshot, workspace] = await Promise.all([workspaceClient.catalog(signal), workspaceClient.workspace(signal)]);
        if (signal.aborted) return;
        installCatalogSnapshot(snapshot);
        installSongChartDetails(snapshot.details);
        let initial = workspace;
        let notice: string | undefined;
        if (!workspace.legacyMigrated) {
          try {
            const legacy = loadLocalState(window.localStorage);
            if (Object.keys(legacy.scores).length || Object.keys(legacy.nicknameOverrides).length) {
              const result = await workspaceClient.migrate(legacy, signal);
              initial = result;
              notice = result.notice;
            }
          } catch (error) {
            notice = `旧浏览器数据迁移未完成：${error instanceof Error ? error.message : '读取失败'}。原副本保留。`;
          }
        }
        if (!signal.aborted) setLoaded({ status: 'ready', workspace: initial, notice });
      } catch (error) {
        if (!signal.aborted) setLoaded({ status: 'error', message: error instanceof Error ? error.message : '无法读取本地数据。' });
      }
    }

    void loadWorkspace();
    return () => controller.abort();
  }, [attempt]);

  if (loaded.status === 'ready') return <App initial={loaded.workspace} initialNotice={loaded.notice} />;
  if (loaded.status === 'loading') return <main><p role="status">正在读取本地数据…</p></main>;

  return <div className="status-banner error" role="alert">
    <div><strong>无法加载工作台</strong><span>{loaded.message}</span></div>
    <button type="button" onClick={() => { setLoaded({ status: 'loading' }); setAttempt(current => current + 1); }}>重试连接</button>
  </div>;
}
