import type { CatalogSnapshot, WorkspaceAction, WorkspaceResult, WorkspaceSnapshot } from '../accountTypes';
import type { LocalState } from '../types';

class WorkspaceApiError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
async function workspaceRequest<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { method, credentials: 'same-origin', signal,
      headers: { 'X-Machun-Request': '1', ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}) },
      ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new WorkspaceApiError('NETWORK_ERROR', '无法连接本地服务，请确认服务已启动。');
  }
  let payload;
  try { payload = await response.json(); }
  catch { throw new WorkspaceApiError('INVALID_RESPONSE', '本地服务返回了无效响应。'); }
  signal?.throwIfAborted();
  if (!response.ok) {
    throw new WorkspaceApiError(payload?.code ?? 'REQUEST_FAILED', payload?.error ?? '请求失败，本次未保存。');
  }
  return payload as T;
}
export const workspaceClient = {
  catalog: (signal?: AbortSignal) => workspaceRequest<CatalogSnapshot>('/catalog', 'GET', undefined, signal),
  workspace: (signal?: AbortSignal) => workspaceRequest<WorkspaceSnapshot>('/workspace', 'GET', undefined, signal),
  action: (action: WorkspaceAction, signal?: AbortSignal) => workspaceRequest<WorkspaceResult>('/workspace/actions', 'POST', action, signal),
  migrate: (state: LocalState, signal?: AbortSignal) => workspaceRequest<WorkspaceResult>('/workspace/migrate', 'POST', { state }, signal),
};
export function newerWorkspace(current: WorkspaceSnapshot, incoming: WorkspaceSnapshot): WorkspaceSnapshot {
  return incoming.revision >= current.revision ? incoming : current;
}
