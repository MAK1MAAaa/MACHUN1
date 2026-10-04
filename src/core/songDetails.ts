import detailData from "../data/song-chart-details.json";
import type { CatalogChart } from "../types";
import { catalog } from "./catalog";

export type SongChartDetail = Pick<CatalogChart, "id" | "difficulty" | "constant">;

// OTOGE DB supplies lower-level charts only for the song detail card.
// Score calculation and import matching continue to use the 13.0+ catalog.
const chartsBySong = new Map<string, SongChartDetail[]>();
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
