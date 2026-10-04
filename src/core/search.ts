import Fuse, { type FuseResult } from "fuse.js";
import type { CatalogChart } from "../types";

export interface SearchSong {
  id: string;
  title: string;
  nickname: string[];
  charts: CatalogChart[];
  searchText: string;
}

export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").trim();
}

export function buildSearchSongs(
  catalog: CatalogChart[],
  nicknameOverrides: Record<string, string[]>,
): SearchSong[] {
  const songs = new Map<string, SearchSong>();
  for (const chart of catalog) {
    const existing = songs.get(chart.id);
    if (existing) {
      existing.charts.push(chart);
      continue;
    }
    const nickname = Array.from(new Set([...chart.nickname, ...(nicknameOverrides[chart.id] ?? [])]));
    songs.set(chart.id, {
      id: chart.id,
      title: chart.title,
      nickname,
      charts: [chart],
      searchText: normalizeSearchText([chart.id, chart.title, ...nickname].join(" ")),
    });
  }
  return Array.from(songs.values()).map((song) => ({
    ...song,
    charts: song.charts.sort((left, right) => right.constant - left.constant),
  }));
}

export function createSongSearch(songs: SearchSong[]): Fuse<SearchSong> {
  return new Fuse(songs, {
    includeScore: true,
    threshold: 0.36,
    ignoreLocation: true,
    minMatchCharLength: 1,
    keys: [
      { name: "id", weight: 1.2 },
      { name: "title", weight: 1 },
      { name: "nickname", weight: 1.1 },
      { name: "searchText", weight: 0.6 },
    ],
  });
}

export function searchSongs(
  fuse: Fuse<SearchSong>,
  songs: SearchSong[],
  query: string,
  limit = 8,
): SearchSong[] {
  const normalized = normalizeSearchText(query);
  if (!normalized) return songs.slice(0, limit);

  const exactId = songs.find((song) => normalizeSearchText(song.id) === normalized);
  const results: FuseResult<SearchSong>[] = fuse.search(normalized, { limit });
  const matches = results.map((result) => result.item);
  if (exactId && matches[0]?.id !== exactId.id) {
    return [exactId, ...matches.filter((song) => song.id !== exactId.id)].slice(0, limit);
  }
  return matches;
}
