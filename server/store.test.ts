import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceStore, type SavedSource } from "./store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup(): Promise<SourceStore> {
  const directory = await mkdtemp(join(tmpdir(), "machun-store-test-"));
  directories.push(directory);
  const store = new SourceStore(directory);
  await store.initialize();
  return store;
}

function savedSource(): SavedSource {
  const identity = { id: "synthetic-account", label: "合成账号", cardId: "synthetic-card" };
  return {
    binding: { identity, profile: "otogame-11111111-1111-4111-8111-111111111111" },
    lastAttemptAt: "2026-10-04T12:00:00.000Z",
    lastSuccessAt: "2026-10-04T12:01:00.000Z",
    otogameCache: {
      identity: { ...identity },
      records: [{
        id: "synthetic-song", title: "合成曲目", difficulty: "MAS", constant: 14,
        score: 1_000_000, rating: 15, source: "otogame", updatedAt: "2026-10-04T11:59:00.000Z",
      }],
      checkpoint: { timestamp: 1_791_111_111_000, boundaryKeys: ["ab".repeat(32)] },
    },
  };
}

describe("local source checkpoint storage", () => {
  it("loads a legacy binding that has no score cache", async () => {
    const store = await setup();
    const legacy = savedSource();
    delete legacy.otogameCache;
    await writeFile(join(store.directory, "otogame.json"), JSON.stringify(legacy), { mode: 0o600 });

    expect(await store.load("otogame")).toEqual(legacy);
    expect((await store.load("otogame")).otogameCache).toBeUndefined();
  });

  it("restores the records and checkpoint together with restricted permissions", async () => {
    const store = await setup();
    const saved = savedSource();
    await store.save("otogame", saved);

    const replacement = new SourceStore(store.directory);
    expect(await replacement.load("otogame")).toEqual(saved);
    expect((await stat(join(store.directory, "otogame.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(store.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(store.directory, "profiles"))).mode & 0o777).toBe(0o700);
  });

  it.each([
    ["another account", (saved: SavedSource) => { saved.otogameCache!.identity.id = "other-account"; }],
    ["another card", (saved: SavedSource) => { saved.otogameCache!.identity.cardId = "other-card"; }],
    ["a negative timestamp", (saved: SavedSource) => { saved.otogameCache!.checkpoint.timestamp = -1; }],
    ["a fractional timestamp", (saved: SavedSource) => { saved.otogameCache!.checkpoint.timestamp = 1.5; }],
    ["an unsafe timestamp", (saved: SavedSource) => { saved.otogameCache!.checkpoint.timestamp = Number.MAX_SAFE_INTEGER + 1; }],
    ["a missing boundary for a timestamp", (saved: SavedSource) => { saved.otogameCache!.checkpoint.boundaryKeys = []; }],
    ["a boundary without a timestamp", (saved: SavedSource) => { saved.otogameCache!.checkpoint.timestamp = null; }],
    ["an invalid boundary key", (saved: SavedSource) => { saved.otogameCache!.checkpoint.boundaryKeys = ["not-a-hash"]; }],
    ["a record from another source", (saved: SavedSource) => { saved.otogameCache!.records[0].source = "rin"; }],
    ["an invalid score", (saved: SavedSource) => { saved.otogameCache!.records[0].score = 1_010_001; }],
    ["duplicate charts", (saved: SavedSource) => { saved.otogameCache!.records.push({ ...saved.otogameCache!.records[0] }); }],
    ["an empty catalog version", (saved: SavedSource) => { saved.otogameCache!.catalogVersion = " "; }],
    ["an unknown strategy", (saved: SavedSource) => { saved.otogameCache!.strategy = "other" as "playlog"; }],
  ] as const)("rejects a cache containing %s", async (_description, corrupt) => {
    const store = await setup();
    const saved = savedSource();
    corrupt(saved);
    await store.save("otogame", saved);

    await expect(store.load("otogame")).rejects.toMatchObject({ code: "STORAGE_ERROR", status: 500 });
  });

  it("accepts an empty playlog checkpoint without inventing a timestamp", async () => {
    const store = await setup();
    const saved = savedSource();
    saved.otogameCache!.checkpoint = { timestamp: null, boundaryKeys: [] };
    await store.save("otogame", saved);

    expect((await store.load("otogame")).otogameCache?.checkpoint).toEqual({ timestamp: null, boundaryKeys: [] });
  });

  it("removes a previous cache when saving a binding without it or an unbound source", async () => {
    const store = await setup();
    const withCache = savedSource();
    await store.save("otogame", withCache);
    const withoutCache = savedSource();
    delete withoutCache.otogameCache;
    await store.save("otogame", withoutCache);
    expect(await store.load("otogame")).toEqual(withoutCache);
    expect(JSON.parse(await readFile(join(store.directory, "otogame.json"), "utf8"))).not.toHaveProperty("otogameCache");

    await store.save("otogame", withCache);
    const unbound: SavedSource = { binding: null, lastAttemptAt: null, lastSuccessAt: null };
    await store.save("otogame", unbound);
    expect(await store.load("otogame")).toEqual(unbound);
  });
});
