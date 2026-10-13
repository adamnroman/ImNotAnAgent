// Scores a cursor trace against the ball's path. Pure functions, no Worker APIs,
// so the same code runs in the tests.

import { RADIUS, DURATION_MS, ballAt, legIndexAt } from "./path.js";

// Tunables. The lag, overshoot and jitter bands are assumptions until tuned on real traces.
export const TUNING = {
  passScore: 75, // human score (0-100) needed to pass
  lagMinMs: 50, // humans are assumed to trail the ball by 50-70 ms
  lagMaxMs: 70,
  touchLagMinMs: 0, // a finger hides the ball, so it sits anywhere from on it to well behind
  touchLagMaxMs: 200,
  lagMarginMs: 30, // suspicion ramps from 0 to 1 across this margin outside the band
  lagSpreadGoodMs: 4, // leg-to-leg variation in lag; a fixed delay has none
  lagSpreadBadMs: 1,
  overshootMinPx: 4, // how far past a turn the cursor must carry to count as an overshoot
  overshootRateGood: 0.5, // share of turns with an overshoot
  overshootRateBad: 0.15,
  jitterGoodPx: 1.5, // side-to-side wobble around the ball's line
  jitterBadPx: 0.5,
  smoothnessGood: 0.3, // wobble should be smooth (hand motion), not white noise
  smoothnessBad: 0.05,
  centredGoodPx: 4, // typical distance from the ball's centre; a script sits dead centre
  centredBadPx: 1.5,
  eventsGood: 200, // pointer events over the whole test
  eventsBad: 80,
};

const STEP_MS = 10; // analysis grid
const HOLD_GAP_MS = 50; // no events for this long means the cursor was still
const SETTLE_MS = 200; // ignore this long after each turn when measuring lag and jitter
const TRACKING_PX = RADIUS * 3; // only measure while the cursor is roughly with the ball
const TURN_WINDOW_MS = 350;
const SMOOTHNESS_LAG = 4; // samples (40 ms)

export const MAX_SAMPLES = 6000;

// Returns an error string, or null if the trace is well formed. trace: [[t, x, y], ...]
export function validateTrace(trace) {
  if (!Array.isArray(trace) || trace.length < 2) return "trace too short";
  if (trace.length > MAX_SAMPLES) return "trace too long";
  let last = -Infinity;
  for (const s of trace) {
    if (!Array.isArray(s) || s.length !== 3 || !s.every(Number.isFinite)) return "bad sample";
    if (s[0] < last) return "timestamps go backwards";
    if (s[0] < -50 || s[0] > DURATION_MS + 50) return "timestamp out of range";
    last = s[0];
  }
  return null;
}

// 0 when value is at `good` or better, 1 at `bad` or worse, linear in between. A measurement
// that could not be taken (null) is no evidence either way, so it raises no suspicion.
const ramp = (value, good, bad) =>
  value === null ? 0 : Math.max(0, Math.min(1, (value - good) / (bad - good)));

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stdev(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
}

// Cursor position on a fixed time grid: interpolate between events, hold across gaps.
function resample(trace) {
  const n = Math.floor(DURATION_MS / STEP_MS);
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = i * STEP_MS;
    while (j + 1 < trace.length && trace[j + 1][0] <= t) j++;
    const a = trace[j];
    const b = trace[j + 1];
    if (!b || t <= a[0] || b[0] - a[0] > HOLD_GAP_MS) {
      xs[i] = a[1];
      ys[i] = a[2];
    } else {
      const f = (t - a[0]) / (b[0] - a[0]);
      xs[i] = a[1] + (b[1] - a[1]) * f;
      ys[i] = a[2] + (b[2] - a[2]) * f;
    }
  }
  return { xs, ys, n };
}

function boxcar(values, width) {
  const half = width >> 1;
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let count = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(values.length - 1, i + half); k++) {
      sum += values[k];
      count++;
    }
    out[i] = sum / count;
  }
  return out;
}

function measure(legs, trace) {
  const { xs, ys, n } = resample(trace);
  const shape = legs.map((leg) => {
    const length = Math.hypot(leg.x1 - leg.x0, leg.y1 - leg.y0) || 1;
    return {
      dx: (leg.x1 - leg.x0) / length,
      dy: (leg.y1 - leg.y0) / length,
      speed: length / (leg.t1 - leg.t0), // px per ms
    };
  });

  let onBall = 0;
  const distances = [];
  const lagsByLeg = legs.map(() => []);
  const wobbleByLeg = legs.map(() => []); // sideways error per grid sample, null when not tracking

  for (let i = 0; i < n; i++) {
    const t = i * STEP_MS;
    const k = legIndexAt(legs, t);
    const ball = ballAt(legs, t);
    const ex = xs[i] - ball.x;
    const ey = ys[i] - ball.y;
    const dist = Math.hypot(ex, ey);
    if (dist <= RADIUS) onBall++;
    distances.push(dist);

    const settled = t - legs[k].t0 >= SETTLE_MS && dist <= TRACKING_PX;
    const { dx, dy, speed } = shape[k];
    if (settled) lagsByLeg[k].push(-(ex * dx + ey * dy) / speed); // how far behind, as time
    wobbleByLeg[k].push(settled ? ey * dx - ex * dy : null);
  }

  // Lag: typical delay behind the ball, and how much it varies from leg to leg.
  const legLags = lagsByLeg.filter((l) => l.length >= 15).map(median);
  const lagMs = median(lagsByLeg.flat());
  const lagSpreadMs = legLags.length >= 3 ? stdev(legLags) : null;

  // Jitter: size of the sideways wobble and whether it is smooth from sample to sample.
  let squares = 0;
  let count = 0;
  let products = 0;
  let pairs = 0;
  for (const wobble of wobbleByLeg) {
    const present = wobble.filter((w) => w !== null);
    if (present.length < 15) continue;
    const mean = present.reduce((a, b) => a + b, 0) / present.length;
    for (let i = 0; i < wobble.length; i++) {
      if (wobble[i] === null) continue;
      const a = wobble[i] - mean;
      squares += a * a;
      count++;
      const later = wobble[i + SMOOTHNESS_LAG];
      if (later !== null && later !== undefined) {
        products += a * (later - mean);
        pairs++;
      }
    }
  }
  const variance = count ? squares / count : 0;
  const jitterPx = count ? Math.sqrt(variance) : null;
  const jitterSmoothness = pairs && variance > 1e-6 ? products / pairs / variance : null;

  // Overshoot: after each turn, how far the cursor carries on in the old direction.
  const sx = boxcar(xs, 5);
  const sy = boxcar(ys, 5);
  const overshoots = [];
  for (let k = 0; k < legs.length - 1; k++) {
    const turnAt = Math.round(legs[k].t1 / STEP_MS);
    if (turnAt >= n) continue;
    const corner = { x: legs[k].x1, y: legs[k].y1 };
    if (Math.hypot(xs[turnAt] - corner.x, ys[turnAt] - corner.y) > TRACKING_PX) continue;
    let carried = 0;
    const end = Math.min(n, turnAt + TURN_WINDOW_MS / STEP_MS);
    for (let i = turnAt; i < end; i++) {
      carried = Math.max(carried, (sx[i] - corner.x) * shape[k].dx + (sy[i] - corner.y) * shape[k].dy);
    }
    overshoots.push(carried);
  }
  const overshootRate =
    overshoots.length >= 3
      ? overshoots.filter((o) => o >= TUNING.overshootMinPx).length / overshoots.length
      : null;

  return {
    accuracy: onBall / n,
    centreDistancePx: median(distances),
    lagMs,
    lagSpreadMs,
    overshootRate,
    overshootMedianPx: median(overshoots),
    jitterPx,
    jitterSmoothness,
    events: trace.length,
  };
}

// pointerType is what the page reported ("mouse", "touch" or "pen"); only touch is scored differently.
export function scoreTrace(legs, trace, pointerType = "mouse") {
  const f = measure(legs, trace);
  const T = TUNING;
  const touch = pointerType === "touch";
  const lagMinMs = touch ? T.touchLagMinMs : T.lagMinMs;
  const lagMaxMs = touch ? T.touchLagMaxMs : T.lagMaxMs;

  const lagSuspicion =
    f.lagMs === null
      ? 0
      : f.lagMs < lagMinMs
        ? ramp(f.lagMs, lagMinMs, lagMinMs - T.lagMarginMs)
        : ramp(f.lagMs, lagMaxMs, lagMaxMs + T.lagMarginMs);

  // Each signal is a suspicion from 0 (looks human) to 1 (looks scripted).
  const signals = {
    lag: lagSuspicion,
    constantLag: ramp(f.lagSpreadMs, T.lagSpreadGoodMs, T.lagSpreadBadMs),
    noOvershoot: ramp(f.overshootRate, T.overshootRateGood, T.overshootRateBad),
    noJitter: ramp(f.jitterPx, T.jitterGoodPx, T.jitterBadPx),
    noisyJitter: ramp(f.jitterSmoothness, T.smoothnessGood, T.smoothnessBad),
    tooCentred: ramp(f.centreDistancePx, T.centredGoodPx, T.centredBadPx),
    fewEvents: ramp(f.events, T.eventsGood, T.eventsBad),
  };

  // Human score: accuracy, scaled down by every suspicion.
  let score = f.accuracy * 100;
  for (const s of Object.values(signals)) score *= 1 - s;
  score = Math.round(score);

  return {
    score,
    botProbability: 100 - score,
    passed: score >= T.passScore,
    threshold: T.passScore,
    features: f,
    signals,
  };
}
