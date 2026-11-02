import releaseDates from '../data/chart-release-dates.json';
import type { CatalogChart } from '../types';

/** Confirmed chart date when available; otherwise the original song release date. */
export function getChartReleaseDate(chart: Pick<CatalogChart, 'id' | 'difficulty'>): string | null {
  return (releaseDates as Record<string, string | null>)[`${chart.id}:${chart.difficulty}`] ?? null;
}
