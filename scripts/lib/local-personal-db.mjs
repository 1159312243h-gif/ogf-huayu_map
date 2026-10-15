import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";

// Execute the production SQL against SQLite, with the small asynchronous D1 API.
export async function createLocalPersonalDatabase(filename = ":memory:") {
  const sqlite = new DatabaseSync(filename);
  sqlite.exec(await readFile(new URL("../../migrations/0001_personal_data.sql", import.meta.url), "utf8"));
  function prepare(sql, values = []) {
    // D1 accepts ArrayBuffer blobs; Node SQLite requires an ArrayBuffer view.
    values = values.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    const statement = sqlite.prepare(sql);
    return {
      bind: (...bound) => prepare(sql, bound),
      async first(column) {
        const row = statement.get(...values);
        return row ? column ? row[column] : {...row} : null;
      },
      async all() { return {success:true, results:statement.all(...values).map(row=>({...row}))}; },
      async run() {
        return this.runSync();
      },
      runSync() {
        const result = statement.run(...values);
        return {success:true, meta:{changes:Number(result.changes)}};
      },
    };
  }
  return {
    prepare,
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(statement.runSync());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {sqlite.exec("ROLLBACK");throw error;}
    },
    close: () => sqlite.close(),
  };
}
