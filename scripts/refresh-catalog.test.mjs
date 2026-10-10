import { describe, expect, it } from 'vitest';
import { refreshCatalog, OCTOBER_SUPPLEMENTS } from './refresh-catalog.mjs';
const official = [...new Map(OCTOBER_SUPPLEMENTS.map(row => [row.id, {
  id: row.id, title: row.title, lev_exp: '12+', lev_mas: '15', catname: 'niconico', image: `${row.id}.jpg`,
}])).values()];
const existing = [{ id: '2317', title: 'きゅうくらりん', difficulty: 'MAS', constant: 13.7, genre: 'niconico', version: 'SUN',
  nickname: ['胃药', 'kyukurarin'], bpm: null, coverUrl: 'https://otoge-db.net/chunithm/jacket/old.jpg', notes: { total: 100, tap: 100, hold: 0, slide: 0, air: 0, flick: 0 } }];
describe('date-bound catalogue refresh', () => {
  it('uses official IDs and the five photo MAS constants and keeps three low EXP charts only in details', () => {
    const result = refreshCatalog([], [], [], official);
    expect(result.charts).toHaveLength(5);
    expect(result.charts.map(row => [row.id, row.constant])).toEqual([['3052', 13.1], ['3054', 13], ['3055', 15.1], ['3064', 14.1], ['3062', 14.7]]);
    expect(result.details).toHaveLength(3);
    expect(result.details).toContainEqual({ id: '3055', difficulty: 'EXP', constant: 12.5 });
    expect(result.charts.every(row => row.bpm === null && row.notes.total === 0)).toBe(true);
  });
  it('adds a new ULT for an existing song while preserving aliases and its debut version', () => {
    const result = refreshCatalog(existing, [], [{ id: 2317, title: 'きゅうくらりん', version: 'Sun', date_added: '20230209',
      lev_mas_i: '13.7', lev_ult_i: '15.0' }], [...official, { id: '2317', title: 'きゅうくらりん', lev_mas: '13+', lev_ult: '15', catname: 'niconico', image: 'old.jpg' }]);
    const ultima = result.charts.find(row => row.id === '2317' && row.difficulty === 'ULT');
    expect(ultima).toMatchObject({ constant: 15, version: 'SUN', nickname: ['胃药', 'kyukurarin'], notes: { total: 0 } });
    expect(result.charts.find(row => row.id === '2317' && row.difficulty === 'MAS').notes.total).toBe(100);
  });
  it('rejects mismatched official song IDs, skips future release dates and refreshes idempotently', () => {
    expect(() => refreshCatalog([], [], [], official.map(row => row.id === '3052' ? { ...row, title: 'wrong' } : row))).toThrow('编号');
    const before = refreshCatalog([], [], [], official, '2026-10-07');
    expect(before.charts).toEqual([]);
    const once = refreshCatalog([], [], [], official);
    expect(refreshCatalog(once.charts, once.details, [], official)).toEqual(once);
  });
});
