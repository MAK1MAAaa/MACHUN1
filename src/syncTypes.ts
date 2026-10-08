import type { SingleRating } from "./types";
import type { ExternalScoreSource, SourceImportReport } from "./core/sources";

export const SYNC_SOURCES = ["munet", "rin", "otogame", "lxns"] as const;
export type BrowserSource = Exclude<ExternalScoreSource, "lxns">;
export type ConnectionStatus = "unbound" | "binding" | "ready" | "syncing" | "auth_required" | "error";

export interface SourceIdentity {
  id: string;
  label: string;
  cardId?: string;
}

export interface SyncProgress {
  completedPages: number;
  retryAt: string | null;
}

export interface SourceConnection {
  source: ExternalScoreSource;
  status: ConnectionStatus;
  bound: boolean;
  identity: SourceIdentity | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  error: string | null;
  progress?: SyncProgress;
  loginUrl?: string;
}

export interface SyncResult {
  source: ExternalScoreSource;
  records: SingleRating[];
  report: SourceImportReport;
  connection: SourceConnection;
}

export interface SyncOptions {
  full?: boolean;
}

export interface ApiError {
  error: string;
  code: string;
}
