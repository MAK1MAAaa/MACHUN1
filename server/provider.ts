import type { BrowserContext, Page } from "playwright";
import type { BrowserSource, SourceIdentity, SyncProgress } from "../src/syncTypes";

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
}

export interface OtogameCheckpoint {
  timestamp: number | null;
  boundaryKeys: string[];
}

export interface IncrementalScoreBatch {
  payload: unknown;
  checkpoint: OtogameCheckpoint;
}

export interface BrowserProvider {
  source: BrowserSource;
  loginUrl: string;
  identify(session: BrowserSession): Promise<SourceIdentity>;
  fetchScores(session: BrowserSession, identity: SourceIdentity, onProgress?: (progress: SyncProgress) => void): Promise<unknown>;
  fetchScoreChanges?(session: BrowserSession, identity: SourceIdentity, checkpoint: OtogameCheckpoint | undefined, onProgress?: (progress: SyncProgress) => void): Promise<IncrementalScoreBatch>;
}

export class SyncError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 502) {
    super(message);
    this.name = "SyncError";
  }
}

export function requireIdentity(actual: SourceIdentity, expected: SourceIdentity): void {
  if (actual.id !== expected.id || actual.cardId !== expected.cardId) {
    throw new SyncError("IDENTITY_CHANGED", "登录账号或绑定卡已变化，请重新绑定后同步。", 409);
  }
}
