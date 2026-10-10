export const DIFFICULTIES = ["EXP", "MAS", "ULT"] as const;

export type Difficulty = (typeof DIFFICULTIES)[number];

export const SCORE_SOURCES = ["manual", "rin", "otogame", "lxns", "munet"] as const;

export type ScoreSource = (typeof SCORE_SOURCES)[number];

export type ComboStatus = "fc" | "aj" | "ajc";
export type FullChainStatus = "fchain" | "gold" | "platinum";

export interface ScoreAchievements {
  combo?: ComboStatus;
  fullChain?: FullChainStatus;
}

export interface ChartNoteProfile {
  total: number;
  tap: number;
  hold: number;
  slide: number;
  air: number;
  flick: number;
}

export interface CatalogChart {
  id: string;
  title: string;
  difficulty: Difficulty;
  constant: number;
  genre: string;
  version: string;
  nickname: string[];
  coverUrl: string;
  bpm: number | null;
  notes: ChartNoteProfile;
}

export interface SingleRating extends ScoreAchievements {
  id: string;
  title: string;
  difficulty: Difficulty;
  constant: number;
  score: number;
  rating: number;
  updatedAt: string;
  source: ScoreSource;
}

export interface LocalState {
  schemaVersion: 2;
  scores: Record<string, SingleRating>;
  nicknameOverrides: Record<string, string[]>;
}

export type ImportMode = "merge" | "replace";

export interface BackupV2 {
  schemaVersion: 2;
  catalogVersion: string;
  exportedAt: string;
  scores: SingleRating[];
  nicknameOverrides: Record<string, string[]>;
}

export interface ImportReport {
  importedScores: number;
  skippedScores: number;
  importedAliases: number;
  warnings: string[];
}
