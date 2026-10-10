// Scores how the count-the-bounces answer was given, separately from whether it was right.
// The page records trusted pointer moves and key presses during the challenge; a browser
// agent that clicks by coordinates and fills the field programmatically leaves almost none.
// Like scoring.js, the bands are assumptions until tuned on real people.

export const BEHAVIOUR = {
  passScore: 75, // human score (0-100) needed, on top of the right count
  movesGood: 20, // trusted pointer moves during the challenge
  movesBad: 3,
  curveGood: 0.01, // how much the pointer path bends; scripted moves are straight lines
  curveBad: 0.001,
  reactionGoodMs: 800, // from the end of the video to the answer
  reactionBadMs: 150,
};

const MAX_POINTER_SAMPLES = 4000;
const MAX_KEYS = 50;
const CURVE_WINDOW = 8; // samples

const ramp = (value, good, bad) => Math.max(0, Math.min(1, (value - good) / (bad - good)));

const isSamples = (list, max, width) =>
  Array.isArray(list) &&
  list.length <= max &&
  list.every((s) => Array.isArray(s) && s.length === width && s.every(Number.isFinite));

// Returns an error string, or null. behaviour: { pointer: [[t, x, y]], keys: [[t, isDigit]], videoEndAt, submitAt }
export function validateBehaviour(b) {
  if (!b || typeof b !== "object") return "missing behaviour";
  if (!isSamples(b.pointer, MAX_POINTER_SAMPLES, 3)) return "bad pointer samples";
  if (!isSamples(b.keys, MAX_KEYS, 2)) return "bad key samples";
  if (!Number.isFinite(b.videoEndAt) || !Number.isFinite(b.submitAt)) return "bad timings";
  return null;
}

// Share of the pointer's travel lost to bending: 0 for perfectly straight moves.
function curviness(pointer) {
  let travelled = 0;
  let straight = 0;
  for (let i = 0; i + CURVE_WINDOW < pointer.length; i += CURVE_WINDOW) {
    let path = 0;
    for (let k = i; k < i + CURVE_WINDOW; k++) {
      path += Math.hypot(pointer[k + 1][1] - pointer[k][1], pointer[k + 1][2] - pointer[k][2]);
    }
    if (path < 4) continue; // the pointer was resting
    travelled += path;
    straight += Math.hypot(pointer[i + CURVE_WINDOW][1] - pointer[i][1], pointer[i + CURVE_WINDOW][2] - pointer[i][2]);
  }
  return travelled ? 1 - straight / travelled : 0;
}

export function scoreBehaviour(b, answer) {
  const T = BEHAVIOUR;
  const digitsTyped = b.keys.filter(([, isDigit]) => isDigit).length;
  const features = {
    pointerMoves: b.pointer.length,
    curviness: curviness(b.pointer),
    digitsTyped,
    reactionMs: b.submitAt - b.videoEndAt,
  };
  // Each signal is a suspicion from 0 (looks human) to 1 (looks scripted).
  const signals = {
    fewPointerMoves: ramp(features.pointerMoves, T.movesGood, T.movesBad),
    straightPointer: ramp(features.curviness, T.curveGood, T.curveBad),
    notTyped: digitsTyped >= String(answer).length ? 0 : 1,
    tooQuick: ramp(features.reactionMs, T.reactionGoodMs, T.reactionBadMs),
  };
  let score = 100;
  for (const s of Object.values(signals)) score *= 1 - s;
  score = Math.round(score);
  return { score, humanEnough: score >= T.passScore, threshold: T.passScore, features, signals };
}
