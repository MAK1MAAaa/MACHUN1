import type { BrowserSource, SourceConnection, SourceIdentity } from './syncTypes';

/** Deliberately excludes cookies, passwords and full browser profiles. */
export interface PortableSession {
  version: 1;
  source: BrowserSource;
  localStorage: Record<string, string>;
}
export type BindingTaskStatus = 'pending' | 'validating' | 'complete' | 'failed' | 'cancelled' | 'expired';
export interface BindingTask {
  id: string;
  source: BrowserSource;
  status: BindingTaskStatus;
  expiresAt: string;
  error: string | null;
  connection?: SourceConnection;
}
export interface CreatedBindingTask extends BindingTask { code: string }
export interface CompanionTask extends BindingTask { loginUrl: string }
export interface BindingSubmission { session: PortableSession; identity: SourceIdentity }
