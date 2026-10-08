import { useEffect, useRef, useState } from 'react';
import { accountClient, newerWorkspace } from '../core/accountClient';
import type { WorkspaceAction, WorkspaceResult, WorkspaceSnapshot } from '../accountTypes';

export function useAccountWorkspace(initial: WorkspaceSnapshot) {
  const [snapshot, setSnapshot] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(initial);
  const alive = useRef(true);
  const pending = useRef(0);
  const abort = useRef(new AbortController());
  useEffect(() => {
    alive.current = true;
    if (abort.current.signal.aborted) abort.current = new AbortController();
    return () => { alive.current = false; abort.current.abort(); };
  }, []);
  function apply(incoming: WorkspaceSnapshot) {
    if (!alive.current) return;
    const next = newerWorkspace(current.current, incoming);
    current.current = next; setSnapshot(next); setError(null);
  }
  async function action(input: WorkspaceAction): Promise<WorkspaceResult> {
    pending.current++; setBusy(true);
    try {
      const result = await accountClient.action(input, abort.current.signal);
      apply(result); return result;
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : '本次未保存。');
      throw failure;
    } finally { pending.current--; if (alive.current) setBusy(pending.current > 0); }
  }
  async function reload() {
    try { apply(await accountClient.workspace(abort.current.signal)); }
    catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : '读取失败。'); }
  }
  return { snapshot, busy, error, apply, action, reload };
}
