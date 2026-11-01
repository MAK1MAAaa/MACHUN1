import { describe, expect, it } from 'vitest';
import { buildChartReleaseDates, normalizeReleaseDate } from './build-chart-release-dates.mjs';

const chart = (id, difficulty = 'MAS', title = id) => ({ id, title, difficulty });

describe('chart release metadata', () => {
  it('validates calendar dates without treating updates as release dates', () => {
    expect(normalizeReleaseDate('20240229')).toBe('2024-02-29');
    expect(normalizeReleaseDate('2023-02-29')).toBeNull();
    expect(normalizeReleaseDate('2026-13-01')).toBeNull();
    const result = buildChartReleaseDates([chart('1')], [{ id: '1', title: '1', date_updated: '20261029' }]);
    expect(result.dates).toEqual({ '1:MAS': null });
    expect(result.stats.unknownDates).toBe(1);
  });

  it('prefers chart releases over song debuts and keeps the confirmed later ULT dates', () => {
    const charts = [chart('1'), chart('1', 'ULT'), chart('2317', 'ULT', 'きゅうくらりん'), chart('2175', 'ULT', 'シル・ヴ・プレジデント')];
    const upstream = [{ id: '1', title: '1', date_added: '20220101', lev_ult_date_added: '2026-08-01' },
      { id: '2317', title: 'きゅうくらりん', date_added: '20230112', date_updated: '20260926' },
      { id: '2175', title: 'シル・ヴ・プレジデント', date_added: '20220414', date_updated: '20261029' }];
    const result = buildChartReleaseDates(charts, upstream);
    expect(result.dates).toEqual({ '1:MAS': '2022-01-01', '1:ULT': '2026-08-01', '2317:ULT': '2026-09-25', '2175:ULT': '2026-10-22' });
    expect(result.stats).toMatchObject({ charts: 4, dated: 4, chartDates: 3, songDates: 1, unknownDates: 0 });
    expect(buildChartReleaseDates(charts, upstream, {}, '2026-10-21').dates['2175:ULT']).toBeNull();
  });

  it('preserves valid missing-source dates, removes stale keys and refreshes idempotently', () => {
    const charts = [chart('1'), chart('2')];
    const upstream = [{ id: '1', title: '1', date_added: '20261022' }];
    const previous = { '1:MAS': '2020-01-01', '2:MAS': '2021-02-03', 'removed:MAS': '2021-01-01' };
    const once = buildChartReleaseDates(charts, upstream, previous);
    expect(once.dates).toEqual({ '1:MAS': '2026-10-22', '2:MAS': '2021-02-03' });
    expect(once.stats.preservedDates).toBe(1);
    expect(buildChartReleaseDates(charts, upstream, once.dates)).toEqual(once);
  });

  it('checks IDs and titles instead of assigning dates from a mismatched song', () => {
    expect(() => buildChartReleaseDates([chart('1')], [{ id: '1', title: 'other', date_added: '20261022' }])).toThrow('编号与曲名不匹配');
    expect(() => buildChartReleaseDates([chart('2175', 'ULT', 'other')], [])).toThrow('编号与曲名不匹配');
    expect(() => buildChartReleaseDates([chart('1'), chart('1')], [])).toThrow('重复');
    expect(() => buildChartReleaseDates([], [], {}, '2026-02-30')).toThrow('截止日期');
  });
});
