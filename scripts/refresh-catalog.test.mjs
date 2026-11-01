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
  it('adds lower chart details for newly introduced songs and excludes songs without a 13.0+ chart', () => {
    const source = [
      { id: 'new', title: 'New song', version: 'Mate', date_added: '20261029', lev_exp_i: '11.3', lev_mas_i: '14.2' },
      { id: 'low', title: 'Low song', version: 'Mate', date_added: '20261029', lev_exp_i: '9.3', lev_mas_i: '12.5' },
    ];
    const songs = source.map(row => ({ ...row, lev_exp: '11', lev_mas: '14', catname: 'ORIGINAL', image: `${row.id}.jpg` }));
    const result = refreshCatalog([], [], source, songs);
    expect(result.charts.map(row => row.id)).toEqual(['new']);
    expect(result.details).toEqual([{ id: 'new', difficulty: 'EXP', constant: 11.3 }]);
  });
  it('bounds a known new ULT by its announced date instead of the original song or metadata update date', () => {
    const row = { id: '2175', title: 'シル・ヴ・プレジデント', version: 'NEW+', date_added: '20220414', date_updated: '20261029', lev_mas_i: '12.6', lev_ult_i: '14.5' };
    const song = { ...row, lev_mas: '12+', lev_ult: '14+', catname: 'POPS & ANIME', image: 'song.jpg' };
    expect(refreshCatalog([], [], [row], [song], '2026-10-21').charts).toEqual([]);
    const result = refreshCatalog([], [], [row], [song], '2026-10-22');
    expect(result.charts).toHaveLength(1);
    expect(result.charts[0]).toMatchObject({ id: '2175', difficulty: 'ULT', constant: 14.5, version: 'NEW PLUS' });
    expect(result.details).toEqual([{ id: '2175', difficulty: 'MAS', constant: 12.6 }]);
  });
  it('uses confirmed updated constants and preserves aliases and valid metadata when upstream fields are absent', () => {
    const previous = { ...existing[0], id: '3055', title: 'SAN値直葬', constant: 15.1, version: 'MATE', bpm: 168 };
    const source = [{ id: '3055', title: previous.title, version: 'Mate', date_added: '20261008', lev_mas_i: '15.2', lev_mas_notes: '100' }];
    const updated = refreshCatalog([previous], [], source, official).charts.find(row => row.id === '3055');
    expect(updated).toMatchObject({ constant: 15.2, bpm: 168, notes: previous.notes, nickname: previous.nickname });
    expect(previous.constant).toBe(15.1);
  });
  it('does not invent a debut version when upstream and previous metadata are both missing', () => {
    const row = { id: 'new', title: 'Unknown version', date_added: '20261029', lev_mas_i: '13.1' };
    expect(() => refreshCatalog([], [], [row], [{ ...row, lev_mas: '13', catname: 'ORIGINAL', image: 'new.jpg' }])).toThrow('缺少已确认版本');
  });
});
