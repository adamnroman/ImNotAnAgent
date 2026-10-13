// Scores the exported traces again with the scoring code as it is now, and prints, per test,
// label and pointer type: how many passed when recorded, how many would pass now, and the
// spread of each measurement. Change a band in src/behaviour.js or src/scoring.js, run this
// again, and compare.
//
//   npm run traces:export && npm run traces:analyse      (or: node tools/analyse-traces.mjs file.ndjson)
//
// Prints summaries only, never a record.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { scoreBehaviour, BEHAVIOUR } from "../src/behaviour.js";
import { scoreTrace, TUNING } from "../src/scoring.js";

const PERCENTILES = [5, 25, 50, 75, 95];

// The typed number is never stored, only how the digits-typed check came out, so the check is
// repeated against a stand-in number of a length that gives the same outcome.
const standInAnswer = (record) => "9".repeat(record.signals.notTyped ? (record.features.digitsTyped ?? 0) + 1 : 1);

// Scores one record with the current code: { passed, score, features, signals }.
export function rescore(record) {
  if (record.test === "follow") {
    const legs = record.legs.map(([t0, t1, x0, y0, x1, y1]) => ({ t0, t1, x0, y0, x1, y1 }));
    const result = scoreTrace(legs, record.trace, record.pointerType);
    return { passed: result.passed, score: result.score, features: result.features, signals: result.signals };
  }
  const behaviour = {
    pointerType: record.pointerType,
    pointer: record.moves,
    keys: record.keys,
    inputs: record.inputs,
    videoEndAt: record.videoEndAt,
    submitAt: record.submitAt,
  };
  const result = scoreBehaviour(behaviour, standInAnswer(record));
  // Passing also needs the right count, which the record holds as yes or no.
  return { passed: result.humanEnough && record.countRight === true, score: result.score, features: result.features, signals: result.signals };
}

function percentile(sorted, p) {
  const at = ((sorted.length - 1) * p) / 100;
  const low = Math.floor(at);
  return sorted[low] + (sorted[Math.min(sorted.length - 1, low + 1)] - sorted[low]) * (at - low);
}

// Groups records by test, label and pointer type. Returns
// [{ test, label, pointerType, count, passedThen, passesNow, countRight, features: { name: { n, p5, ... } } }].
export function summarise(records) {
  const groups = new Map();
  for (const record of records) {
    const name = `${record.test}|${record.label}|${record.pointerType}`;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(record);
  }
  return [...groups.entries()].sort().map(([name, group]) => {
    const [test, label, pointerType] = name.split("|");
    const rescored = group.map(rescore);
    const values = {};
    for (const { score, features } of rescored) {
      for (const [feature, value] of Object.entries({ ...features, score })) {
        if (Number.isFinite(value)) (values[feature] ??= []).push(value);
      }
    }
    const features = {};
    for (const [feature, list] of Object.entries(values)) {
      list.sort((a, b) => a - b);
      features[feature] = { n: list.length, ...Object.fromEntries(PERCENTILES.map((p) => [`p${p}`, percentile(list, p)])) };
    }
    return {
      test,
      label,
      pointerType,
      count: group.length,
      passedThen: group.filter((r) => r.passed).length,
      passesNow: rescored.filter((r) => r.passed).length,
      countRight: test === "bounce" ? group.filter((r) => r.countRight).length : null,
      features,
    };
  });
}

function print(summaries) {
  const share = (n, of) => `${n}/${of} (${Math.round((n / of) * 100)}%)`;
  const show = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(4));
  for (const s of summaries) {
    console.log(`\n${s.test}  ${s.label}  ${s.pointerType}  (${s.count} attempts)`);
    console.log(`  passed when recorded ${share(s.passedThen, s.count)}, would pass now ${share(s.passesNow, s.count)}`);
    if (s.countRight !== null) console.log(`  count right ${share(s.countRight, s.count)}`);
    console.log(`  ${"measurement".padEnd(20)}${["n", ...PERCENTILES.map((p) => `p${p}`)].map((h) => h.padStart(10)).join("")}`);
    for (const [feature, f] of Object.entries(s.features)) {
      console.log(`  ${feature.padEnd(20)}${[String(f.n), ...PERCENTILES.map((p) => show(f[`p${p}`]))].map((v) => v.padStart(10)).join("")}`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2] ?? new URL("../data/traces.ndjson", import.meta.url);
  const records = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  if (!records.length) console.log("no records");
  print(summarise(records));
  console.log("\nbands now: bounce", JSON.stringify(BEHAVIOUR), "\n           follow", JSON.stringify(TUNING));
}
