import type { Account, CatalogSnapshot, WorkspaceAction, WorkspaceResult, WorkspaceSnapshot } from '../accountTypes';
import type { LocalState } from '../types';

export class AccountApiError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export async function accountRequest<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { method, credentials: 'same-origin', signal,
      headers: { 'X-Machun-Request': '1', ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}) },
      ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new AccountApiError('NETWORK_ERROR', '无法连接服务；当前页面数据保留，请确认本地服务和 SSH 隧道正在运行。');
  }
  let payload;
  try { payload = await response.json(); }
  catch { throw new AccountApiError('INVALID_RESPONSE', '服务返回了无效响应；当前页面数据保留，请确认网页与后台版本一致。'); }
  if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
  if (!response.ok) {
    if (response.status === 401 && payload.code === 'UNAUTHORIZED' && typeof window !== 'undefined') window.dispatchEvent(new Event('machun-session-expired'));
    throw new AccountApiError(payload.code ?? 'REQUEST_FAILED', payload.error ?? '请求失败，本次未保存。');
  }
  return payload as T;
}
export const accountClient = {
  session: () => accountRequest<{ user: Account | null }>('/auth/session'),
  login: (username: string, password: string) => accountRequest<{ user: Account }>('/auth/login', 'POST', { username, password }),
  logout: () => accountRequest('/auth/logout', 'POST'),
  catalog: () => accountRequest<CatalogSnapshot>('/catalog'),
  workspace: (signal?: AbortSignal) => accountRequest<WorkspaceSnapshot>('/workspace', 'GET', undefined, signal),
  action: (action: WorkspaceAction, signal?: AbortSignal) => accountRequest<WorkspaceResult>('/workspace/actions', 'POST', action, signal),
  migrate: (state: LocalState) => accountRequest<WorkspaceResult>('/workspace/migrate', 'POST', { state }),
};
export function newerWorkspace(current: WorkspaceSnapshot, incoming: WorkspaceSnapshot): WorkspaceSnapshot {
  return incoming.revision >= current.revision ? incoming : current;
}
