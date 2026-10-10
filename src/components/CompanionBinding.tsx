import { useEffect, useRef, useState } from 'react';
import { accountRequest } from '../core/accountClient';
import { copyText } from '../core/clipboard';
import type { CreatedBindingTask, BindingTask } from '../sourceBindingTypes';
import type { BrowserSource } from '../syncTypes';
import './CompanionBinding.css';

export function CompanionBinding({ source, onDone, onClose }: { source: BrowserSource; onDone: () => void; onClose: () => void }) {
  const [task, setTask] = useState<CreatedBindingTask | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const abort = useRef(new AbortController());
  const onDoneRef = useRef(onDone); onDoneRef.current = onDone;
  useEffect(() => {
    if (abort.current.signal.aborted) abort.current = new AbortController();
    return () => abort.current.abort();
  }, []);
  async function create() {
    if (creatingRef.current) return;
    creatingRef.current = true; setCreating(true); setError(''); setNotice('');
    try { setTask(await accountRequest<CreatedBindingTask>(`/sources/${source}/binding-tasks`, 'POST', {}, abort.current.signal)); }
    catch (error) { if (!abort.current.signal.aborted) setError(error instanceof Error ? error.message : '任务创建失败'); }
    finally { creatingRef.current = false; if (!abort.current.signal.aborted) setCreating(false); }
  }
  const active = task?.status === 'pending' || task?.status === 'validating';
  useEffect(() => {
    if (!task || !active) return;
    let polling = false;
    const poll = async () => {
      if (polling) return; polling = true;
      try {
        const next = await accountRequest<BindingTask>(`/source-binding-tasks/${task.id}`, 'GET', undefined, abort.current.signal);
        setTask(current => current?.id === next.id ? { ...next, code: ['pending', 'validating'].includes(next.status) ? current.code : '' } : current);
        setError('');
        if (next.status === 'complete') onDoneRef.current();
      } catch (error) { if (!abort.current.signal.aborted) setError(error instanceof Error ? error.message : '读取绑定状态失败'); }
      finally { polling = false; }
    };
    const timer = window.setInterval(() => { void poll(); }, 1500);
    return () => window.clearInterval(timer);
  }, [task?.id, active]);
  const command = task ? `pnpm login:remote --server ${window.location.origin} --task ${task.id}` : '';
  async function copy(value: string) {
    setNotice(await copyText(value) ? '已复制' : '复制失败，请选中文本后复制。');
  }
  async function cancel() {
    try {
      if (task && active) await accountRequest(`/source-binding-tasks/${task.id}`, 'DELETE', {}, abort.current.signal);
      onClose(); onDoneRef.current();
    } catch (error) { setError(error instanceof Error ? error.message : '取消失败'); }
  }
  return <div className="companion-binding">
    <p>在电脑项目目录运行助手，手动登录官方门户；完成后可在手机同步。</p>
    {!task && <button type="button" disabled={creating} onClick={() => { void create(); }}>{creating ? '正在生成' : '生成绑定任务'}</button>}
    {task && <>
      {active && <>
        <label>助手命令<textarea readOnly value={command} rows={3} aria-label="助手命令" /></label>
        <button type="button" onClick={() => { void copy(command); }}>复制命令</button>
        <label>绑定码<input readOnly value={task.code} aria-label="绑定码" autoComplete="off" /></label>
        <button type="button" onClick={() => { void copy(task.code); }}>复制绑定码</button>
        <p>在终端提示后粘贴绑定码，{new Date(task.expiresAt).toLocaleTimeString('zh-CN', { hour12: false })} 到期。</p>
      </>}
      <p role="status">{{ pending: '等待电脑登录', validating: '服务器正在核对账号与卡片', complete: '绑定成功', failed: '绑定失败', cancelled: '已取消', expired: '任务已过期' }[task.status]}</p>
      {task.error && <p role="alert">{task.error}</p>}
      {!active && task.status !== 'complete' && <button type="button" disabled={creating} onClick={() => { void create(); }}>重新生成</button>}
    </>}
    <button type="button" onClick={() => { void cancel(); }}>{active ? '取消绑定任务' : '关闭'}</button>
    {notice && <span role="status">{notice}</span>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
