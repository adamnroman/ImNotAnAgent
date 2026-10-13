// Opt-in collection of behavioural traces, so the scoring bands (guesses until now) can be
// tuned on real phones and desktops. Off unless all of these hold:
//   - COLLECT_TRACES is "true" and the COLLECT_KEY secret is set,
//   - the attempt came from a link carrying that key and a known label
//     (/bounce?collect=KEY&label=human-phone), so only labelled test sessions are recorded,
//   - the TRACES database (D1) is bound.
// Without them nothing is written and responses are the same as with collection absent.
//
// A record is built field by field from the list below, never copied from the request, so
// nothing else can end up stored: no IP, user agent, site, session or challenge id, video,
// colour, answer or typed number. Only the day is kept, not the time. Records are removed
// after KEEP_DAYS, and trace data is never logged.

import { json, sha256Hex } from "./tokens.js";

export const LABELS = ["human-phone", "human-desktop", "bot"];
export const KEEP_DAYS = 30;
export const MAX_RECORD_BYTES = 150000;
export const MAX_RECORDS_PER_DAY = 300;

const MIN_KEY_LENGTH = 16; // a short key could be guessed
const POINTER_TYPES = ["mouse", "touch", "pen"];
const MAX_MOVES = 6000;
const MAX_TAPS = 500;
const MAX_KEYS = 50;
const MAX_MEASUREMENTS = 40;
const DAY_MS = 86400000;

const encoder = new TextEncoder();
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10); // UTC

// The last day whose records have run out: one written on it is KEEP_DAYS old at most.
export const lastExpiredDay = (now) => dayOf(now - KEEP_DAYS * DAY_MS);

// Whether collection is switched on and `key` is the collection key.
export async function keyAccepted(env, key) {
  if (env.COLLECT_TRACES !== "true" || !env.TRACES) return false;
  const secret = env.COLLECT_KEY;
  if (typeof secret !== "string" || secret.length < MIN_KEY_LENGTH || typeof key !== "string") return false;
  // Compared as hashes so the time taken says nothing about how much of the key matched.
  const [given, wanted] = await Promise.all([sha256Hex(`collect|${key}`), sha256Hex(`collect|${secret}`)]);
  let difference = 0;
  for (let i = 0; i < wanted.length; i++) difference |= given.charCodeAt(i) ^ wanted.charCodeAt(i);
  return difference === 0;
}

const accepted = async (env, collect) =>
  Boolean(collect) && typeof collect === "object" && LABELS.includes(collect.label) && (await keyAccepted(env, collect.key));

// POST /api/collect/check { key, label }: lets the page know whether to show the notice and record.
export const collectCheck = async (env, body) => json({ collecting: await accepted(env, body) });

const number = (value, min, max) =>
  Number.isFinite(value) ? Math.round(Math.min(max, Math.max(min, value)) * 10) / 10 : null;
const time = (value) => number(value, -60000, 600000);
const place = (value) => number(value, -20000, 20000);
const flag = (value) => (value ? 1 : 0);

// Copies a list of fixed-width samples, passing each column through its own cleaner.
const samples = (list, max, columns) =>
  (Array.isArray(list) ? list : [])
    .filter((s) => Array.isArray(s) && s.length === columns.length)
    .slice(0, max)
    .map((s) => columns.map((clean, i) => clean(s[i])));

// The scorer's features and signals: numbers, plus the pointer type it scored as.
function measurements(values) {
  const out = {};
  for (const [name, value] of Object.entries(values ?? {}).slice(0, MAX_MEASUREMENTS)) {
    if (!/^[A-Za-z]{1,32}$/.test(name)) continue;
    if (value === null || typeof value === "boolean" || POINTER_TYPES.includes(value)) out[name] = value;
    else if (Number.isFinite(value)) out[name] = Math.round(value * 1e5) / 1e5;
  }
  return out;
}

// Everything a record holds. attempt: what the Worker knows about the attempt
// ({ test, variant, behaviour, trace, legs, passed, countRight, score, features, signals });
// collect: what the page recorded for collection only (viewport, taps, input events, replays).
export function buildRecord({ label, now, collect, attempt }) {
  const behaviour = attempt.behaviour ?? {};
  const pointerType = [behaviour.pointerType, collect.pointerType].find((t) => POINTER_TYPES.includes(t)) ?? "unknown";
  const record = {
    v: 1,
    test: attempt.test === "follow" ? "follow" : "bounce",
    variant: typeof attempt.variant === "string" && /^[a-z]{1,16}$/.test(attempt.variant) ? attempt.variant : null,
    label,
    day: dayOf(now),
    viewport: [number(collect.viewport?.[0], 0, 20000), number(collect.viewport?.[1], 0, 20000)],
    pointerType,
    // [kind, t, x, y]; kind 0 = down, 1 = up, 2 = cancelled (the browser took the touch, e.g. to scroll)
    taps: samples(collect.taps, MAX_TAPS, [(kind) => number(kind, 0, 2), time, place, place]),
    passed: attempt.passed === true,
    countRight: typeof attempt.countRight === "boolean" ? attempt.countRight : null,
    score: number(attempt.score, 0, 100),
    features: measurements(attempt.features),
    signals: measurements(attempt.signals),
  };
  if (record.test === "bounce") {
    Object.assign(record, {
      moves: samples(behaviour.pointer, MAX_MOVES, [time, place, place]), // [t, x, y], as scored
      keys: samples(behaviour.keys, MAX_KEYS, [time, flag]), // [t, was it a digit]
      inputs: samples(collect.inputs ?? behaviour.inputs, MAX_KEYS, [time, flag]),
      videoEndAt: time(behaviour.videoEndAt),
      submitAt: time(behaviour.submitAt),
      replays: number(collect.replays, 0, 99),
    });
  } else {
    Object.assign(record, {
      trace: samples(attempt.trace, MAX_MOVES, [time, place, place]), // [t, x, y], as scored
      // The ball's path, so the trace can be scored again. It says nothing about the visitor.
      legs: (attempt.legs ?? []).slice(0, 100).map((l) => [l.t0, l.t1, l.x0, l.y0, l.x1, l.y1].map((v) => number(v, 0, 60000))),
    });
  }
  return record;
}

// Removes records that have run out. Runs before every write and once a day (see index.js).
export const expireTraces = (env, now = Date.now()) =>
  env.TRACES.prepare("DELETE FROM traces WHERE day <= ?").bind(lastExpiredDay(now)).run();

// Stores one record unless it is too large or the day is full. Returns whether it was stored.
export async function storeTrace(env, record, now = Date.now()) {
  const text = JSON.stringify(record);
  if (encoder.encode(text).length > MAX_RECORD_BYTES) return false;
  const [, inserted] = await env.TRACES.batch([
    env.TRACES.prepare("DELETE FROM traces WHERE day <= ?").bind(lastExpiredDay(now)),
    // The count and the insert are one statement, so two writes at once cannot both take the last place.
    env.TRACES.prepare(
      "INSERT INTO traces (day, label, test, record) SELECT ?1, ?2, ?3, ?4 WHERE (SELECT COUNT(*) FROM traces WHERE day = ?1) < ?5",
    ).bind(record.day, record.label, record.test, text, MAX_RECORDS_PER_DAY),
  ]);
  return inserted.meta.changes === 1;
}

// Records a scored attempt if the request carries the collection key. Returns undefined when
// it does not (the response then says nothing about collection), else whether it was stored.
// A failure to store never changes the test's result and is not logged.
export async function collectTrace(env, collect, attempt, now = Date.now()) {
  if (!(await accepted(env, collect))) return undefined;
  try {
    return await storeTrace(env, buildRecord({ label: collect.label, now, collect, attempt }), now);
  } catch {
    return false;
  }
}
