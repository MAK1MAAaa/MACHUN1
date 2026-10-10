import { useEffect, useRef, useState, type FormEvent } from 'react';
import App from '../App';
import { accountClient } from '../core/accountClient';
import { installCatalogSnapshot } from '../core/catalog';
import { installSongChartDetails } from '../core/songDetails';
import { loadLocalState } from '../core/storage';
import type { Account, WorkspaceSnapshot } from '../accountTypes';
import './AccountApp.css';

export function AccountApp() {
  const [loaded, setLoaded] = useState<{ user: Account; workspace: WorkspaceSnapshot; notice?: string } | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const epoch = useRef(0);
  async function restore() {
    const sequence = ++epoch.current;
    setChecking(true); setError(null);
    try {
      const { user } = await accountClient.session();
      if (!user) { if (sequence === epoch.current) setLoaded(null); return; }
      const [snapshot, workspace] = await Promise.all([accountClient.catalog(), accountClient.workspace()]);
      if (sequence !== epoch.current) return;
      installCatalogSnapshot(snapshot); installSongChartDetails(snapshot.details);
      let initial = workspace;
      let notice: string | undefined;
      if (user.username === 'root' && !workspace.legacyMigrated) {
        try {
          const old = loadLocalState(window.localStorage);
          const result = await accountClient.migrate(old);
          initial = result; notice = result.notice;
        } catch (migrationError) {
          notice = `旧浏览器数据迁移未完成：${migrationError instanceof Error ? migrationError.message : '读取失败'}。原副本保留。`;
        }
      }
      if (sequence === epoch.current) setLoaded({ user, workspace: initial, notice });
    } catch (failure) {
      if (sequence === epoch.current) setError(failure instanceof Error ? failure.message : '无法读取账号数据。');
    } finally { if (sequence === epoch.current) setChecking(false); }
  }
  useEffect(() => {
    void restore();
    const expired = () => { epoch.current++; setLoaded(null); setChecking(false); setError('登录已失效，请重新登录。'); };
    window.addEventListener('machun-session-expired', expired);
    return () => { epoch.current++; window.removeEventListener('machun-session-expired', expired); };
  }, []);
  async function login(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError(null);
    try { await accountClient.login(username, password); setPassword(''); await restore(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '登录失败。'); }
    finally { setBusy(false); }
  }
  async function logout() {
    if (busy) return;
    const sequence = ++epoch.current;
    setBusy(true);
    try {
      await accountClient.logout();
      if (sequence !== epoch.current) return;
      setLoaded(null); setUsername(''); setPassword(''); setError(null);
    } catch (failure) {
      if (sequence === epoch.current) setError(failure instanceof Error ? failure.message : '退出失败。');
    } finally { setBusy(false); }
  }
  if (loaded) return <><div className="account-toolbar"><span>已登录 <strong>{loaded.user.username}</strong></span><button type="button" disabled={busy} onClick={() => { void logout(); }}>退出登录</button></div>{error && <p role="alert" className="account-error">{error}</p>}<App key={loaded.user.username} account={loaded.user} initial={loaded.workspace} initialNotice={loaded.notice} /></>;
  return <main className="login-shell"><section className="login-card" aria-labelledby="login-title">
    <span className="eyebrow">MACHUN1 RATING WORKSPACE</span><h1 id="login-title">登录 MACHUN1</h1><p>登录后查看和管理自己的成绩。</p>
    {checking ? <p role="status">正在读取登录状态…</p> : <form onSubmit={event => { void login(event); }}>
      <label className="field-group"><span>用户名</span><input autoComplete="username" required maxLength={64} value={username} onChange={event => setUsername(event.target.value)} disabled={busy} /></label>
      <label className="field-group"><span>密码</span><input type="password" autoComplete="current-password" required maxLength={1024} value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /></label>
      <button type="submit" className="confirm login-submit" disabled={busy}>{busy ? '正在登录…' : '登录'}</button>
    </form>}
    {error && <div className="account-error" role="alert"><p>{error}</p><button type="button" disabled={busy || checking} onClick={() => { void restore(); }}>重试连接</button></div>}
  </section></main>;
}
