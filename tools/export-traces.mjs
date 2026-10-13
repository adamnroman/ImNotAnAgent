// Pulls the collected traces (src/traces.js) into data/traces.ndjson, one record per line:
//   npm run traces:export             from the deployed database (needs wrangler to be logged in)
//   npm run traces:export -- --local  from the local `wrangler dev` database
// data/ is gitignored: the records are real people's input timings and stay off GitHub.
// Only counts are printed, never the records.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { KEEP_DAYS, lastExpiredDay } from "../src/traces.js";

const DATABASE = "imnotanagent-traces";
const PAGE = 20; // rows per query; a record can be 150 KB
const root = new URL("../", import.meta.url);
const where = process.argv.includes("--local") ? "--local" : "--remote";

function query(sql) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", DATABASE, where, "--json", "--command", sql], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(out)[0].results;
}

// Records past their time are left out even if the daily clean-up has not run yet.
const expired = lastExpiredDay(Date.now());
const lines = [];
const perLabel = {};
for (let after = 0; ; ) {
  const rows = query(`SELECT id, record FROM traces WHERE id > ${after} AND day > '${expired}' ORDER BY id LIMIT ${PAGE}`);
  if (!rows.length) break;
  for (const row of rows) {
    const record = { id: row.id, ...JSON.parse(row.record) };
    lines.push(JSON.stringify(record));
    perLabel[record.label] = (perLabel[record.label] ?? 0) + 1;
  }
  after = rows.at(-1).id;
}

mkdirSync(new URL("data/", root), { recursive: true });
writeFileSync(new URL("data/traces.ndjson", root), lines.map((l) => l + "\n").join(""), { mode: 0o600 });
console.log(`wrote ${lines.length} records from the last ${KEEP_DAYS} days to data/traces.ndjson`, perLabel);
