import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExternalScoreSource } from "../src/core/sources";
import type { SourceIdentity } from "../src/syncTypes";
import { SyncError, type OtogameCheckpoint } from "./provider";
import type { SingleRating } from "../src/types";
import { parseLocalState } from "../src/core/storage";

export interface SavedBinding {
  identity: SourceIdentity;
  profile?: string;
  token?: string;
}

export interface SavedSource {
  binding: SavedBinding | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  otogameCache?: {
    identity: SourceIdentity;
    records: SingleRating[];
    checkpoint: OtogameCheckpoint;
    catalogVersion?: string;
    strategy?: "playlog";
  };
}

const PROFILE_PATTERN = /^(munet|rin|otogame)-[a-f0-9-]{36}$/;

export class SourceStore {
  constructor(readonly directory: string) {}

  async initialize(): Promise<void> {
    await mkdir(join(this.directory, "profiles"), { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    await chmod(join(this.directory, "profiles"), 0o700);
  }

  async load(source: ExternalScoreSource): Promise<SavedSource> {
    try {
      const raw: unknown = JSON.parse(await readFile(join(this.directory, `${source}.json`), "utf8"));
      if (!raw || typeof raw !== "object") throw new Error("invalid");
      const value = raw as SavedSource;
      if (value.binding !== null) {
        const b = value.binding;
        if (!b || typeof b !== "object" || !b.identity || typeof b.identity.id !== "string" ||
          typeof b.identity.label !== "string" || (b.identity.cardId !== undefined && typeof b.identity.cardId !== "string")) throw new Error("invalid");
        if (source === "lxns" ? typeof b.token !== "string" || !b.token :
          typeof b.profile !== "string" || !PROFILE_PATTERN.test(b.profile) || !b.profile.startsWith(`${source}-`)) throw new Error("invalid");
      }
      for (const date of [value.lastAttemptAt, value.lastSuccessAt]) {
        if (date !== null && (typeof date !== "string" || !Number.isFinite(Date.parse(date)))) throw new Error("invalid");
      }
      if (value.otogameCache !== undefined) {
        const cache = value.otogameCache;
        if (source !== "otogame" || !value.binding || !cache || typeof cache !== "object"
          || !cache.identity || cache.identity.id !== value.binding.identity.id
          || cache.identity.cardId !== value.binding.identity.cardId || !Array.isArray(cache.records)
          || cache.records.some((record) => record?.source !== "otogame")
          || (cache.catalogVersion !== undefined && (typeof cache.catalogVersion !== "string" || !cache.catalogVersion.trim()))
          || (cache.strategy !== undefined && cache.strategy !== "playlog")
          || !cache.checkpoint || typeof cache.checkpoint !== "object"
          || (cache.checkpoint.timestamp !== null && (!Number.isSafeInteger(cache.checkpoint.timestamp) || cache.checkpoint.timestamp < 0))
          || !Array.isArray(cache.checkpoint.boundaryKeys)
          || cache.checkpoint.boundaryKeys.some((key) => typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key))
          || (cache.checkpoint.timestamp === null) !== (cache.checkpoint.boundaryKeys.length === 0)) throw new Error("invalid cache");
        const parsed = parseLocalState(JSON.stringify({ schemaVersion: 2, scores: cache.records, nicknameOverrides: {} }));
        if (Object.keys(parsed.scores).length !== cache.records.length) throw new Error("duplicate cache");
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { binding: null, lastAttemptAt: null, lastSuccessAt: null };
      }
      throw new SyncError("STORAGE_ERROR", `${source} 的本地绑定文件无法读取，请检查本地数据目录。`, 500);
    }
  }

  async save(source: ExternalScoreSource, value: SavedSource): Promise<void> {
    const path = join(this.directory, `${source}.json`);
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      await chmod(temp, 0o600);
      await rename(temp, path);
    } finally {
      // Once rename commits the document, cleanup must not report a false save failure.
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  profilePath(profile: string): string {
    if (!PROFILE_PATTERN.test(profile)) throw new SyncError("STORAGE_ERROR", "本地浏览器目录无效。", 500);
    return join(this.directory, "profiles", profile);
  }

  async newProfile(source: Exclude<ExternalScoreSource, "lxns">): Promise<string> {
    const profile = `${source}-${randomUUID()}`;
    await mkdir(this.profilePath(profile), { mode: 0o700 });
    return profile;
  }

  async removeProfile(profile: string): Promise<void> {
    await rm(this.profilePath(profile), { recursive: true, force: true });
  }
}
