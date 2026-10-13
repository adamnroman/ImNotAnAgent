// Trace collection (src/traces.js) must store nothing unless it is switched on and the request
// carries the collection key, must store only the listed fields, and must keep to its limits.
// Runs the real statements on an in-memory SQLite database (tools/local-d1.mjs) with the repository's
// migration applied. Needs the rendered pool, like bounce.test.js.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pool from "../src/bounce-pool.json" with { type: "json" };
import worker from "../src/index.js";
import { localD1 } from "../tools/local-d1.mjs";
import { decrypt } from "../src/tokens.js";
import { DURATION_MS } from "../src/path.js";
import { KEEP_DAYS, LABELS, MAX_RECORD_BYTES, MAX_RECORDS_PER_DAY, buildRecord, collectTrace, storeTrace } from "../src/traces.js";
import { rescore, summarise } from "../tools/analyse-traces.mjs";

const KEY = "0123456789abcdef0123456789abcdef";
const SITE = "https://shop.example";
const IP = "203.0.113.77";
const USER_AGENT = "TestBrowser/9.9 (Phone; Secret Build)";
const COOKIE = "sid=cookie-monster";
const DAY_MS = 86400000;
const NOON = Date.parse("2026-03-10T12:00:00Z");

const migration = readFileSync(new URL("../migrations/0001_traces.sql", import.meta.url), "utf8");
let db;

// A fresh, empty database and Worker environment. Collection is on unless `vars` says otherwise.
async function freshEnv(vars = {}) {
  db = localD1();
  await db.exec(migration);
  const kv = new Map();
  return {
    CAPTCHA_SECRET: "test-secret",
    COLLECT_TRACES: "true",
    COLLECT_KEY: KEY,
    TRACES: db,
    USED: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v) },
    ASSETS: { fetch: async () => new Response("GIF89a") },
    ...vars,
  };
}

const rows = async () => (await db.prepare("SELECT * FROM traces ORDER BY id").all()).results;

const post = async (env, path, body) => {
  const res = await worker.fetch(
    new Request(`https://captcha.example${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": IP, "user-agent": USER_AGENT, cookie: COOKIE, origin: SITE },
      body: JSON.stringify(body),
    }),
    env,
  );
  return { status: res.status, data: await res.json() };
};

// Runs `fn` with the clock set by the `at` function it is given.
async function withClock(fn) {
  const realNow = Date.now;
  try {
    return await fn((ms) => (Date.now = () => ms));
  } finally {
    Date.now = realNow;
  }
}

// What the page sends for collection, plus things it must never be able to get stored.
const collectFrom = (extra = {}) => ({
  key: KEY,
  label: "human-phone",
  viewport: [390, 844],
  pointerType: "touch",
  taps: [[0, 6900.4, 120.5, 610.2], [1, 6985.1, 120.9, 611], [0, 8100, 300, 640], [1, 8160, 300, 640]],
  inputs: [[7600, 1], [7780, 7]],
  replays: 1,
  ip: IP,
  userAgent: USER_AGENT,
  answer: 77,
  note: "free text must not be stored",
  ...extra,
});

// One answered bounce challenge, human-looking and right unless told otherwise.
async function bounceAttempt(env, { collect, variant = "flicker", wrong = false, at = NOON } = {}) {
  return withClock(async (clock) => {
    clock(at);
    const start = (await post(env, "/api/bounce/start", { variant, site: SITE })).data;
    const challenge = await decrypt(env, "bounce", start.challenge);
    const video = pool.videos[variant].find((v) => v.id === challenge.video);
    const right = (video.answers?.[challenge.colour] ?? video).bounces;
    const answer = wrong ? right + 1 : right;
    const pointer = [];
    for (let t = 0; t < 7000; t += 16) pointer.push([t, 150 + Math.sin(t / 300) * 60 + (t % 48) / 8, 200 + Math.cos(t / 450) * 40 - (t % 80) / 8]);
    // The second number of a key sample should be 0 or 1; a page that sent the digit itself must not get it stored.
    const keys = [...String(answer)].map((digit, i) => [7600 + i * 180, Number(digit) + 2]);
    clock(at + 8200);
    const verify = await post(env, "/api/bounce/verify", {
      challenge: start.challenge,
      answer,
      behaviour: { pointer, keys, videoEndAt: 6800, submitAt: 8200 },
      collect,
    });
    return { verify, challenge, video, answer };
  });
}

// One follow-the-ball test through the real protocol, with a cursor that trails the ball.
async function followAttempt(env, collect, at = NOON) {
  return withClock(async (clock) => {
    clock(at);
    let { session, chain, leg, last, leadMs } = (await post(env, "/api/start", {})).data;
    const segments = [];
    let from = 0;
    const samplesFor = (l, to) => {
      const out = [];
      for (let t = Math.ceil(from / 8) * 8; t <= to; t += 8) {
        const f = Math.max(0, Math.min(1, (t - 60 - l.t0) / (l.t1 - l.t0)));
        out.push([t, Math.round(l.x0 + (l.x1 - l.x0) * f + Math.sin(t / 90) * 3), Math.round(l.y0 + (l.y1 - l.y0) * f)]);
      }
      from = to + 0.1;
      return out;
    };
    while (!last) {
      const upTo = Math.ceil(leg.t1 - leadMs);
      clock(at + upTo);
      const samples = samplesFor(leg, upTo);
      const next = (await post(env, "/api/leg", { session, chain, upTo, samples })).data;
      segments.push(samples);
      ({ chain, leg, last } = next);
    }
    clock(at + DURATION_MS);
    segments.push(samplesFor(leg, DURATION_MS));
    const verify = await post(env, "/api/verify", { session, chain, segments, collect });
    return { verify, session };
  });
}

const BOUNCE_FIELDS = ["v", "test", "variant", "label", "day", "viewport", "pointerType", "taps", "passed", "countRight", "score", "features", "signals", "moves", "keys", "inputs", "videoEndAt", "submitAt", "replays"];
const FOLLOW_FIELDS = ["v", "test", "variant", "label", "day", "viewport", "pointerType", "taps", "passed", "countRight", "score", "features", "signals", "trace", "legs"];
const ALLOWED_WORDS = new Set(["bounce", "follow", "plain", "dots", "flicker", ...LABELS, "mouse", "touch", "pen", "unknown"]);

// Every string anywhere in a value.
function stringsIn(value, found = []) {
  if (typeof value === "string") found.push(value);
  else if (value && typeof value === "object") for (const v of Object.values(value)) stringsIn(v, found);
  return found;
}

test("off by default: the committed config has collection switched off", () => {
  const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(config, /"COLLECT_TRACES": "false"/);
  assert.doesNotMatch(config, /COLLECT_KEY"\s*:/); // the key is a secret, never a var in the repo
});

test("key gate: nothing is written unless collection is on and the key and label are right", async () => {
  const refused = [
    [{ COLLECT_TRACES: "false" }, collectFrom()],
    [{ COLLECT_TRACES: undefined }, collectFrom()],
    [{ COLLECT_KEY: undefined }, collectFrom()],
    [{ COLLECT_KEY: undefined }, collectFrom({ key: undefined })],
    [{ COLLECT_KEY: "" }, collectFrom({ key: "" })],
    [{ COLLECT_KEY: "short" }, collectFrom({ key: "short" })], // a guessable key is no key
    [{}, collectFrom({ key: KEY.slice(0, -1) + "0" })],
    [{}, collectFrom({ key: KEY.slice(0, -1) })],
    [{}, collectFrom({ key: KEY + "f" })],
    [{}, collectFrom({ key: undefined })],
    [{}, collectFrom({ key: { length: 32 } })],
    [{}, collectFrom({ label: "public" })],
    [{}, collectFrom({ label: undefined })],
    [{}, undefined], // ordinary traffic
    [{}, "human-phone"],
  ];
  for (const [vars, collect] of refused) {
    const env = await freshEnv(vars);
    const { verify } = await bounceAttempt(env, { collect });
    assert.equal(verify.status, 200);
    assert.equal(verify.data.passed, true);
    assert.ok(!("recorded" in verify.data), "the response must not mention collection");
    assert.equal((await rows()).length, 0);
    if (collect && typeof collect === "object") {
      assert.deepEqual((await post(env, "/api/collect/check", collect)).data, { collecting: false });
    }
  }

  for (const label of LABELS) {
    const env = await freshEnv();
    assert.deepEqual((await post(env, "/api/collect/check", { key: KEY, label })).data, { collecting: true });
    const { verify } = await bounceAttempt(env, { collect: collectFrom({ label }) });
    assert.equal(verify.data.recorded, true);
    assert.deepEqual((await rows()).map((r) => r.label), [label]);
  }
});

test("key gate: the follow-the-ball test is gated the same way", async () => {
  for (const [vars, collect] of [[{ COLLECT_TRACES: "false" }, collectFrom()], [{}, collectFrom({ key: "wrong-key-wrong-key" })], [{}, undefined]]) {
    const env = await freshEnv(vars);
    const { verify } = await followAttempt(env, collect);
    assert.equal(verify.status, 200);
    assert.ok(!("recorded" in verify.data));
    assert.equal((await rows()).length, 0);
  }
});

test("redaction: a bounce record holds the listed fields and nothing that identifies anyone or the answer", async () => {
  for (const wrong of [false, true]) {
    const env = await freshEnv();
    const { verify, challenge, video, answer } = await bounceAttempt(env, { collect: collectFrom(), wrong });
    assert.equal(verify.data.recorded, true);
    const [row] = await rows();
    assert.deepEqual(Object.keys(row).sort(), ["day", "id", "label", "record", "test"]);
    assert.equal(row.day, "2026-03-10"); // the day only, no time
    const record = JSON.parse(row.record);
    assert.deepEqual(Object.keys(record).sort(), [...BOUNCE_FIELDS].sort());

    const stored = JSON.stringify(row);
    for (const forbidden of [IP, USER_AGENT, "TestBrowser", COOKIE, "cookie-monster", SITE, "shop.example", "captcha.example", challenge.id, video.id, KEY, "free text"]) {
      assert.ok(!stored.includes(forbidden), `${forbidden} was stored`);
    }
    for (const text of stringsIn(record)) assert.ok(ALLOWED_WORDS.has(text) || text === row.day, `unexpected text ${text}`);
    assert.equal(record.variant, "flicker");
    assert.ok(!stored.includes(challenge.colour), "the colour asked about was stored");

    // The count is kept as right or wrong, and digits as "a digit was typed": never their value.
    assert.equal(record.countRight, !wrong);
    assert.equal(record.passed, !wrong);
    assert.equal(record.keys.length, String(answer).length);
    for (const [, isDigit] of [...record.keys, ...record.inputs]) assert.ok(isDigit === 0 || isDigit === 1);
    for (const name of Object.keys({ ...record.features, ...record.signals })) assert.doesNotMatch(name, /answer|bounces|feints/i);
    const numbers = (list) => list.every((s) => s.every((v) => typeof v === "number"));
    assert.ok(numbers(record.moves) && numbers(record.taps) && numbers(record.keys) && numbers(record.inputs));

    // What is meant to be there is there.
    assert.deepEqual(record.viewport, [390, 844]);
    assert.equal(record.pointerType, "touch");
    assert.equal(record.moves.length, 438);
    assert.deepEqual(record.taps[0], [0, 6900.4, 120.5, 610.2]);
    assert.deepEqual([record.videoEndAt, record.submitAt, record.replays], [6800, 8200, 1]);
    assert.equal(typeof record.score, "number");
    assert.ok("pointerMoves" in record.features && "tooQuick" in record.signals);
  }
});

test("redaction: text smuggled into any recorded field is dropped", () => {
  const smuggled = "203.0.113.77 Mozilla";
  const record = buildRecord({
    label: "bot",
    now: NOON,
    collect: { viewport: [smuggled, 800], pointerType: smuggled, taps: [[0, 1, smuggled, 3], [0, 1, 2, 3, smuggled]], inputs: [[5, smuggled]], replays: smuggled, [smuggled]: 1 },
    attempt: {
      test: "bounce", variant: smuggled, passed: smuggled, countRight: smuggled, score: smuggled, session: smuggled,
      behaviour: { pointerType: smuggled, pointer: [[1, 2, smuggled]], keys: [[smuggled, smuggled]], videoEndAt: smuggled, submitAt: 5, ip: smuggled },
      features: { reactionMs: 12, note: smuggled, [smuggled]: 4, nested: { a: smuggled } },
      signals: { tooQuick: 0.5, why: [smuggled] },
    },
  });
  assert.ok(!JSON.stringify(record).includes("203"), JSON.stringify(record));
  assert.deepEqual(record.features, { reactionMs: 12 });
  assert.deepEqual(record.signals, { tooQuick: 0.5 });
  assert.equal(record.pointerType, "unknown");
});

test("redaction: a follow-the-ball record holds the trace and path, and no session", async () => {
  const env = await freshEnv();
  const { verify, session } = await followAttempt(env, collectFrom({ label: "human-desktop", pointerType: "mouse", taps: [[0, -310.5, 180, 180]] }));
  assert.equal(verify.data.recorded, true);
  const [row] = await rows();
  const record = JSON.parse(row.record);
  assert.deepEqual(Object.keys(record).sort(), [...FOLLOW_FIELDS].sort());
  const sessionId = JSON.parse(Buffer.from(session.split(".")[0], "base64url")).id;
  const stored = JSON.stringify(row);
  for (const forbidden of [IP, USER_AGENT, COOKIE, "shop.example", "captcha.example", sessionId, session, KEY, "free text"]) {
    assert.ok(!stored.includes(forbidden), `${forbidden} was stored`);
  }
  for (const text of stringsIn(record)) assert.ok(ALLOWED_WORDS.has(text) || text === row.day, `unexpected text ${text}`);
  assert.ok(record.trace.length > 500);
  assert.ok(record.legs.length > 1);
  assert.equal(record.countRight, null);
  assert.equal(record.pointerType, "mouse");
  assert.equal(record.passed, verify.data.passed);
  assert.equal(record.score, verify.data.score);
});

test("no trace data is logged, also when storing fails", async () => {
  const logged = [];
  const real = {};
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    real[method] = console[method];
    console[method] = (...args) => logged.push(args);
  }
  try {
    const env = await freshEnv();
    assert.equal((await bounceAttempt(env, { collect: collectFrom() })).verify.data.recorded, true);
    env.TRACES = { batch: async () => { throw new Error("database is down"); } };
    const { verify } = await bounceAttempt(env, { collect: collectFrom() });
    assert.equal(verify.data.passed, true, "a failed write must not change the result");
    assert.equal(verify.data.recorded, false);
  } finally {
    Object.assign(console, real);
  }
  assert.deepEqual(logged, []);
});

test("cap: a record over 150 KB is not stored", async () => {
  const env = await freshEnv();
  assert.equal(MAX_RECORD_BYTES, 150000);
  const record = (padding) => ({ day: "2026-03-10", label: "bot", test: "bounce", padding });
  const overhead = JSON.stringify(record("")).length;
  assert.equal(await storeTrace(env, record("x".repeat(MAX_RECORD_BYTES - overhead + 1)), NOON), false);
  assert.equal((await rows()).length, 0);
  assert.equal(await storeTrace(env, record("x".repeat(MAX_RECORD_BYTES - overhead)), NOON), true);
  // Counted in bytes, not characters.
  assert.equal(await storeTrace(env, record("é".repeat((MAX_RECORD_BYTES - overhead) / 2 + 1)), NOON), false);
  assert.equal((await rows()).length, 1);

  // A real attempt that large: the longest pointer recording the test accepts, plus as many taps as fit.
  const pointer = Array.from({ length: 4000 }, (_, i) => [50000.5 + i, 1234.5, 1234.5]);
  const taps = Array.from({ length: 5000 }, (_, i) => [0, 50000.5 + i, 1234.5, 1234.5]);
  const attempt = { test: "bounce", variant: "plain", passed: true, countRight: true, score: 90, behaviour: { pointer, keys: [], videoEndAt: 1, submitAt: 2 } };
  const big = buildRecord({ label: "bot", now: NOON, collect: { taps }, attempt });
  assert.equal(big.taps.length, 500); // lists are cut to their limits
  assert.ok(JSON.stringify(big).length <= MAX_RECORD_BYTES);
});

test("cap: at most 300 records a day, across labels", async () => {
  const env = await freshEnv();
  assert.equal(MAX_RECORDS_PER_DAY, 300);
  const record = (now, label) => ({ day: new Date(now).toISOString().slice(0, 10), label, test: "bounce" });
  for (let i = 0; i < MAX_RECORDS_PER_DAY; i++) assert.equal(await storeTrace(env, record(NOON, LABELS[i % 3]), NOON), true);
  for (const label of LABELS) assert.equal(await storeTrace(env, record(NOON, label), NOON), false);
  assert.equal((await rows()).length, 300);

  // Through the Worker: the attempt still passes, and is reported as not recorded.
  const full = await bounceAttempt(env, { collect: collectFrom() });
  assert.equal(full.verify.data.passed, true);
  assert.equal(full.verify.data.recorded, false);
  assert.equal((await rows()).length, 300);

  // Several writes at once cannot squeeze past the limit either.
  await db.prepare("DELETE FROM traces WHERE id IN (SELECT id FROM traces LIMIT 2)").run();
  const racing = await Promise.all(Array.from({ length: 10 }, () => storeTrace(env, record(NOON, "bot"), NOON)));
  assert.equal(racing.filter(Boolean).length, 2);
  assert.equal((await rows()).length, 300);

  // The next day starts again from nothing.
  const next = await bounceAttempt(env, { collect: collectFrom(), at: NOON + DAY_MS });
  assert.equal(next.verify.data.recorded, true);
  assert.equal((await rows()).length, 301);
});

test("expiry: records are removed 30 days after their day, on the next write or the daily run", async () => {
  assert.equal(KEEP_DAYS, 30);
  const record = (now) => ({ day: new Date(now).toISOString().slice(0, 10), label: "bot", test: "bounce" });
  const days = async () => (await rows()).map((r) => r.day);
  const dayStart = Date.parse("2026-03-10T00:00:00Z");

  // On a write.
  let env = await freshEnv();
  await storeTrace(env, record(NOON), NOON);
  await storeTrace(env, record(dayStart + 30 * DAY_MS - 1), dayStart + 30 * DAY_MS - 1); // one ms short of 30 days
  assert.deepEqual(await days(), ["2026-03-10", "2026-04-08"]);
  await storeTrace(env, record(dayStart + 30 * DAY_MS), dayStart + 30 * DAY_MS);
  assert.deepEqual(await days(), ["2026-04-08", "2026-04-09"]);

  // A write that is itself refused (the key gate passed, the day is full or not) still cleans up;
  // and no record ever outlives 30 days from the moment it was written.
  env = await freshEnv();
  const lastMoment = dayStart + DAY_MS - 1;
  await storeTrace(env, record(lastMoment), lastMoment);
  await storeTrace(env, record(lastMoment + 30 * DAY_MS), lastMoment + 30 * DAY_MS);
  assert.deepEqual(await days(), ["2026-04-09"]);

  // On the daily run, with collection switched off and no writes arriving.
  env = await freshEnv({ COLLECT_TRACES: "false" });
  await storeTrace(env, record(NOON), NOON);
  await storeTrace(env, record(NOON + 5 * DAY_MS), NOON + 5 * DAY_MS);
  await withClock(async (clock) => {
    clock(NOON + 29 * DAY_MS);
    await worker.scheduled({}, env);
    assert.deepEqual(await days(), ["2026-03-10", "2026-03-15"]);
    clock(NOON + 30 * DAY_MS);
    await worker.scheduled({}, env);
    assert.deepEqual(await days(), ["2026-03-15"]);
    clock(NOON + 400 * DAY_MS);
    await worker.scheduled({}, env);
    assert.deepEqual(await days(), []);
  });
  await worker.scheduled({}, { ...env, TRACES: undefined }); // no database bound: nothing to do, no error
});

test("analysis: stored records score the same again, and are summarised per label and pointer type", async () => {
  const env = await freshEnv();
  await bounceAttempt(env, { collect: collectFrom({ pointerType: "mouse", label: "human-desktop" }) });
  await bounceAttempt(env, { collect: collectFrom({ pointerType: "mouse", label: "human-desktop" }), wrong: true });
  await bounceAttempt(env, { collect: collectFrom(), variant: "plain" });
  await followAttempt(env, collectFrom({ label: "bot", pointerType: "mouse" }));
  // A direct call, as the tests above make through the Worker, returns the same thing.
  assert.equal(await collectTrace(env, { key: "nope" }, {}), undefined);

  const records = (await rows()).map((r) => ({ id: r.id, ...JSON.parse(r.record) }));
  assert.equal(records.length, 4);
  for (const record of records) {
    const again = rescore(record);
    assert.equal(again.passed, record.passed);
    assert.equal(again.score, record.score);
  }

  const summary = summarise(records);
  assert.deepEqual(summary.map((s) => [s.test, s.label, s.pointerType, s.count]), [
    ["bounce", "human-desktop", "mouse", 2],
    ["bounce", "human-phone", "touch", 1],
    ["follow", "bot", "mouse", 1],
  ]);
  const desktop = summary[0];
  assert.deepEqual([desktop.passedThen, desktop.passesNow, desktop.countRight], [1, 1, 1]);
  assert.equal(desktop.features.pointerMoves.p50, 438);
  assert.deepEqual(Object.keys(desktop.features.reactionMs), ["n", "p5", "p25", "p50", "p75", "p95"]);
  assert.ok("lagMs" in summary[2].features);
});
