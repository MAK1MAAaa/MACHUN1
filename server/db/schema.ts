import { boolean, char, datetime, decimal, double, int, json, mysqlEnum, mysqlTable, primaryKey, varchar } from 'drizzle-orm/mysql-core';
import type { ChartNoteProfile, Difficulty } from '../../src/types';
import type { SavedSource } from '../store';

export const users = mysqlTable('users', {
  username: varchar('username', { length: 64 }).primaryKey(),
  pwd: char('pwd', { length: 64 }).notNull(),
});
export const sessions = mysqlTable('sessions', {
  tokenHash: char('token_hash', { length: 64 }).primaryKey(),
  username: varchar('username', { length: 64 }).notNull().references(() => users.username),
  expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
});
export const catalogMeta = mysqlTable('catalog_meta', {
  id: int('id').primaryKey(), version: varchar('version', { length: 128 }).notNull(), date: char('date', { length: 10 }).notNull(),
  provenance: json('provenance').$type<Record<string, unknown>>().notNull(),
});
export const songs = mysqlTable('songs', {
  id: varchar('id', { length: 64 }).primaryKey(), title: varchar('title', { length: 512 }).notNull(),
  genre: varchar('genre', { length: 64 }).notNull(), version: varchar('version', { length: 64 }).notNull(),
  coverUrl: varchar('cover_url', { length: 1024 }).notNull(),
  aliases: json('aliases').$type<string[]>().notNull(),
});
export const charts = mysqlTable('charts', {
  songId: varchar('song_id', { length: 64 }).notNull().references(() => songs.id),
  difficulty: mysqlEnum('difficulty', ['EXP', 'MAS', 'ULT']).$type<Difficulty>().notNull(),
  constant: decimal('constant', { precision: 3, scale: 1, mode: 'number' }).notNull(),
  bpm: double('bpm'),
  notes: json('notes').$type<ChartNoteProfile | null>(), scoring: boolean('scoring').notNull(), position: int('position').notNull(),
}, table => [primaryKey({ columns: [table.songId, table.difficulty] })]);
export const workspaces = mysqlTable('workspaces', {
  username: varchar('username', { length: 64 }).primaryKey().references(() => users.username),
  revision: int('revision', { unsigned: true }).notNull().default(0),
  legacyMigrated: boolean('legacy_migrated').notNull().default(false),
  sourcesMigrated: boolean('sources_migrated').notNull().default(false),
});
export const scores = mysqlTable('scores', {
  username: varchar('username', { length: 64 }).notNull().references(() => users.username),
  songId: varchar('song_id', { length: 64 }).notNull(), difficulty: mysqlEnum('difficulty', ['EXP', 'MAS', 'ULT']).$type<Difficulty>().notNull(),
  score: int('score', { unsigned: true }).notNull(), source: mysqlEnum('source', ['manual', 'rin', 'otogame', 'lxns', 'munet']).notNull(),
  combo: mysqlEnum('combo', ['fc', 'aj', 'ajc']), fullChain: mysqlEnum('full_chain', ['fchain', 'gold', 'platinum']),
  updatedAt: varchar('updated_at', { length: 64 }).notNull(),
}, table => [primaryKey({ columns: [table.username, table.songId, table.difficulty] })]);
export const personalAliases = mysqlTable('personal_aliases', {
  username: varchar('username', { length: 64 }).notNull().references(() => users.username),
  songId: varchar('song_id', { length: 64 }).notNull(), aliases: json('aliases').$type<string[]>().notNull(),
}, table => [primaryKey({ columns: [table.username, table.songId] })]);
export const sourceStates = mysqlTable('source_states', {
  username: varchar('username', { length: 64 }).notNull().references(() => users.username),
  source: mysqlEnum('source', ['rin', 'munet', 'otogame', 'lxns']).notNull(),
  state: json('state').$type<SavedSource>().notNull(),
}, table => [primaryKey({ columns: [table.username, table.source] })]);
