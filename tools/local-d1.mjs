// A stand-in for a D1 database in tests: the same calls src/traces.js makes, run on an
// in-memory SQLite database (D1 is SQLite), so the real statements and the real migration
// are exercised. Needs Node 22.13 or later for node:sqlite.

import { DatabaseSync } from "node:sqlite";

export function localD1() {
  const sqlite = new DatabaseSync(":memory:");
  const statement = (sql, params = []) => ({
    bind: (...values) => statement(sql, values),
    runNow() {
      const prepared = sqlite.prepare(sql);
      if (/^\s*select/i.test(sql)) return { success: true, results: prepared.all(...params), meta: { changes: 0 } };
      return { success: true, results: [], meta: { changes: Number(prepared.run(...params).changes) } };
    },
    run: async () => statement(sql, params).runNow(),
    all: async () => statement(sql, params).runNow(),
  });
  return {
    prepare: (sql) => statement(sql),
    exec: async (sql) => void sqlite.exec(sql),
    // Like D1, a batch is one transaction.
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((s) => s.runNow());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
