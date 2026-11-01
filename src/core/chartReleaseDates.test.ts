import { describe, expect, it } from 'vitest';
import { catalog } from './catalog';
import { getChartReleaseDate } from './chartReleaseDates';
import releaseDates from '../data/chart-release-dates.json';
import sources from '../data/catalog-sources.json';

describe('catalog release-date snapshot', () => {
  it('covers each scoring chart with a known, date-bounded release', () => {
    expect(Object.keys(releaseDates)).toHaveLength(catalog.length);
    for (const chart of catalog) {
      const date = getChartReleaseDate(chart);
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(date! <= sources.date).toBe(true);
    }
    expect(sources.releaseDateMetadata).toMatchObject({ charts: catalog.length, dated: catalog.length, unknownDates: 0, chartDates: 2 });
  });

  it('uses announced ULT dates without changing the original song date', () => {
    expect(getChartReleaseDate({ id: '2317', difficulty: 'MAS' })).toBe('2023-01-12');
    expect(getChartReleaseDate({ id: '2317', difficulty: 'ULT' })).toBe('2026-09-25');
    expect(getChartReleaseDate({ id: '2175', difficulty: 'ULT' })).toBe('2026-10-22');
    expect(getChartReleaseDate({ id: 'not-in-catalog', difficulty: 'ULT' })).toBeNull();
  });
});
