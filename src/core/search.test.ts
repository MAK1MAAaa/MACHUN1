import { describe, expect, it } from "vitest";
import type { CatalogChart } from "../types";
import { buildSearchSongs, createSongSearch, searchSongs } from "./search";

const charts: CatalogChart[] = [
  {
    id: "100",
    title: "World Vanquisher",
    difficulty: "MAS",
    constant: 15.5,
    genre: "ORIGINAL",
    version: "AIR PLUS",
    nickname: ["世界终结者", "wv"],
    coverUrl: "https://example.com/100.jpg",
    bpm: 180,
    notes: { total: 1000, tap: 500, hold: 100, slide: 150, air: 200, flick: 50 },
  },
  {
    id: "100",
    title: "World Vanquisher",
    difficulty: "ULT",
    constant: 15.7,
    genre: "ORIGINAL",
    version: "AIR PLUS",
    nickname: ["世界终结者", "wv"],
    coverUrl: "https://example.com/100.jpg",
    bpm: 180,
    notes: { total: 1100, tap: 550, hold: 100, slide: 150, air: 250, flick: 50 },
  },
  {
    id: "200",
    title: "怒槌",
    difficulty: "MAS",
    constant: 15.4,
    genre: "ORIGINAL",
    version: "AIR PLUS",
    nickname: [],
    coverUrl: "https://example.com/200.jpg",
    bpm: 200,
    notes: { total: 1200, tap: 650, hold: 100, slide: 150, air: 250, flick: 50 },
  },
];

describe("song search", () => {
  const songs = buildSearchSongs(charts, { "200": ["怒锤"] });
  const fuse = createSongSearch(songs);

  it("groups charts belonging to the same song", () => {
    expect(songs).toHaveLength(2);
    expect(songs.find((song) => song.id === "100")?.charts).toHaveLength(2);
  });

  it("matches title, alias and exact id", () => {
    expect(searchSongs(fuse, songs, "vanquish")[0].id).toBe("100");
    expect(searchSongs(fuse, songs, "世界终结者")[0].id).toBe("100");
    expect(searchSongs(fuse, songs, "wv")[0].id).toBe("100");
    expect(searchSongs(fuse, songs, "200")[0].id).toBe("200");
  });
});
