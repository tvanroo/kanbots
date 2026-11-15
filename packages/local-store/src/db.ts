import Database from 'better-sqlite3';

export type Db = Database.Database;

export function openDb(filename: string): Db {
  const db = new Database(filename);
  applyPragmas(db, filename);
  return db;
}

/**
 * Reuse compiled statements. Repositories call `db.prepare(sql)` on every
 * query; compiling the same SQL again on each call dominated the main
 * process's time once boards had thousands of runs (the coordinator looks up
 * every job's runs on each 3 s tick and on each renderer poll). Statements are
 * keyed by their SQL text and bounded so dynamically built `IN (?, ?, …)`
 * queries cannot grow the cache without limit. No caller changes a
 * statement's mode (pluck/raw/expand/safeIntegers) or iterates one, so a
 * shared statement behaves exactly like a freshly prepared one.
 */
export function cachePreparedStatements(db: Db, maxEntries = 512): Db {
  const prepare = db.prepare.bind(db);
  const cache = new Map<string, ReturnType<Db['prepare']>>();
  db.prepare = ((source: string) => {
    const hit = cache.get(source);
    if (hit) {
      // Refresh recency so hot statements survive eviction.
      cache.delete(source);
      cache.set(source, hit);
      return hit;
    }
    const statement = prepare(source);
    cache.set(source, statement);
    if (cache.size > maxEntries) cache.delete(cache.keys().next().value as string);
    return statement;
  }) as Db['prepare'];
  return db;
}

function applyPragmas(db: Db, filename: string): void {
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (filename !== ':memory:') {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
}
