// Runs simulated cursors through the scorer. These check the scoring logic against the
// assumed human profile in TUNING; they are not a substitute for tuning on real traces.

import test from "node:test";
import assert from "node:assert/strict";
import { DURATION_MS, SIZE, buildLegs, ballAt } from "../src/path.js";
import { scoreTrace } from "../src/scoring.js";

const RUNS = 20;
const EVENT_MS = 8; // a 125 Hz mouse

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gauss = (rand) => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

function legsFor(run) {
  const seed = new Uint8Array(4);
  new DataView(seed.buffer).setUint32(0, 1000 + run * 7919);
  return buildLegs(seed);
}

// Samples a cursor model every EVENT_MS, rounded to whole pixels like real mouse events.
function record(positionAt) {
  const trace = [];
  for (let t = 0; t <= DURATION_MS; t += EVENT_MS) {
    const p = positionAt(t);
    trace.push([t, Math.round(p.x), Math.round(p.y)]);
  }
  return trace;
}

const cursors = {
  // Sits exactly on the ball.
  perfect: (legs) => record((t) => ballAt(legs, t)),

  // Never moves.
  parked: () => record(() => ({ x: SIZE / 2, y: SIZE / 2 })),

  // Replays the ball's position 60 ms late.
  delayed: (legs) => record((t) => ballAt(legs, Math.max(0, t - 60))),

  // Same, with independent random noise on every event.
  delayedWithNoise: (legs, rand) =>
    record((t) => {
      const b = ballAt(legs, Math.max(0, t - 60));
      return { x: b.x + gauss(rand) * 3, y: b.y + gauss(rand) * 3 };
    }),

  // A hand: trails the ball, is slow to notice a turn (so it carries on past the corner),
  // has momentum, and drifts smoothly.
  humanLike: (legs, rand) => {
    const stiffness = 40; // rad/s
    const damping = 0.5;
    const drift = { x: 0, y: 0 };
    const pos = { x: SIZE / 2, y: SIZE / 2 };
    const vel = { x: 0, y: 0 };
    const trailMs = legs.map(() => 25 + rand() * 20);
    const noticeTurnMs = legs.map(() => 110 + rand() * 80);
    // Where the hand believes the ball is: the previous leg, extended, until the turn registers.
    const believed = (t) => {
      const k = Math.max(0, legs.findIndex((l) => t <= l.t1));
      if (k === 0 || t - legs[k].t0 >= noticeTurnMs[k]) return ballAt(legs, Math.max(0, t - trailMs[k]));
      const prev = legs[k - 1];
      const f = (t - trailMs[k] - prev.t0) / (prev.t1 - prev.t0);
      return { x: prev.x0 + (prev.x1 - prev.x0) * f, y: prev.y0 + (prev.y1 - prev.y0) * f };
    };
    const trace = [];
    for (let t = 0; t <= DURATION_MS; t++) {
      const target = believed(t);
      for (const axis of ["x", "y"]) {
        const accel = stiffness ** 2 * (target[axis] - pos[axis]) - 2 * damping * stiffness * vel[axis];
        vel[axis] += accel * 0.001;
        pos[axis] += vel[axis] * 0.001;
        drift[axis] += -drift[axis] / 200 + gauss(rand) * 2.5 * Math.sqrt(2 / 200);
      }
      if (t % EVENT_MS === 0) trace.push([t, Math.round(pos.x + drift.x), Math.round(pos.y + drift.y)]);
    }
    return trace;
  },
};

function passRate(name) {
  let passed = 0;
  for (let run = 0; run < RUNS; run++) {
    const legs = legsFor(run);
    if (scoreTrace(legs, cursors[name](legs, rng(run + 1))).passed) passed++;
  }
  return passed / RUNS;
}

test("paths stay inside the square and cover the whole test", () => {
  for (let run = 0; run < RUNS; run++) {
    const legs = legsFor(run);
    assert.equal(legs[0].t0, 0);
    assert.equal(legs.at(-1).t1, DURATION_MS);
    for (const leg of legs) {
      for (const v of [leg.x0, leg.y0, leg.x1, leg.y1]) assert.ok(v >= 0 && v <= SIZE);
      assert.ok(leg.t1 > leg.t0);
    }
  }
});

for (const bot of ["perfect", "parked", "delayed", "delayedWithNoise"]) {
  test(`${bot} cursor never passes`, () => assert.equal(passRate(bot), 0));
}

test("human-like cursor usually passes", () => assert.ok(passRate("humanLike") >= 0.8));

// `node test/scoring.test.js --report` prints the measurements behind each verdict.
if (process.argv.includes("--report")) {
  for (const name of Object.keys(cursors)) {
    const legs = legsFor(0);
    const r = scoreTrace(legs, cursors[name](legs, rng(1)));
    console.log(name, "pass rate", passRate(name), JSON.stringify({ score: r.score, ...r.features, signals: r.signals }));
  }
}
