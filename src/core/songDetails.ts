import detailData from "../data/song-chart-details.json";
import type { CatalogChart } from "../types";
import { catalog } from "./catalog";

export type SongChartDetail = Pick<CatalogChart, "id" | "difficulty" | "constant">;

// OTOGE DB supplies lower-level charts only for the song detail card.
// Score calculation and import matching continue to use the 13.0+ catalog.
let chartsBySong = new Map<string, SongChartDetail[]>();
const seen = new Set<string>();
const charts: SongChartDetail[] = [
  ...catalog.map(({ id, difficulty, constant }) => ({ id, difficulty, constant })),
  ...(detailData as SongChartDetail[]),
];

for (const chart of charts) {
  const key = `${chart.id}:${chart.difficulty}`;
  // Catalog constants take precedence over supplementary metadata.
  if (seen.has(key)) continue;
  seen.add(key);
  const songCharts = chartsBySong.get(chart.id) ?? [];
  songCharts.push(chart);
  chartsBySong.set(chart.id, songCharts);
}

export function getSongCharts(id: string): readonly SongChartDetail[] {
  return chartsBySong.get(id) ?? [];
}

export function installSongChartDetails(details: SongChartDetail[]): void {
  const next = new Map<string, SongChartDetail[]>();
  const seen = new Set<string>();
  for (const chart of [...catalog, ...details]) {
    if (!chart.id || !["EXP", "MAS", "ULT"].includes(chart.difficulty) || !Number.isFinite(chart.constant) || chart.constant <= 0) throw new Error("详情谱面无效");
    const key = `${chart.id}:${chart.difficulty}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rows = next.get(chart.id) ?? [];
    rows.push({ id: chart.id, difficulty: chart.difficulty, constant: chart.constant });
    next.set(chart.id, rows);
  }
  chartsBySong = next;
}
