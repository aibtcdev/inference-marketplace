/**
 * Minimal D1 stand-in backed by node:sqlite, loaded with schema.sql, so tests run
 * the real SQL in src/directory.ts.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

type Bound = unknown[];

export function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (sql: string, args: Bound = []) => ({
    bind: (...a: Bound) => stmt(sql, a),
    async all<T>() {
      return { results: db.prepare(sql).all(...(args as never[])) as T[] };
    },
    async first<T>() {
      return (db.prepare(sql).get(...(args as never[])) ?? null) as T | null;
    },
    async run() {
      const r = db.prepare(sql).run(...(args as never[]));
      return { meta: { changes: Number(r.changes) } };
    },
  });
  return { prepare: (sql: string) => stmt(sql), raw: db };
}
