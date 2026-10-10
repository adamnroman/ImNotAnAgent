// Build-time generator for the count-the-bounces videos (run by build-bounce-pool.mjs).
// It simulates a ball bouncing around a square and renders it as a 50 fps GIF. Some turns
// are feints that stop short of the wall and do not count.
//
// Three variants share the same physics and differ in how the ball is drawn:
//   plain    a solid ball.
//   dots     the ball is a patch of random dots moving over flickering random dots, so any
//            single frame is noise and the ball exists only as motion across frames.
//   flicker  three balls that each alternate between two colours every frame. The eye blends
//            each pair into one steady colour; no single frame contains that colour, and the
//            ball showing a given colour changes every frame.

import { mulberry32 } from "../src/path.js";
import { createGif } from "./gif.js";

const SIZE = 240; // px
const BORDER = 3;
const FRAME_CS = 2; // 2 centiseconds per frame = 50 fps, the fastest browsers will play a GIF
const LEAD_IN_CS = 80; // hold the first frame so the viewer is ready
const DURATION_MS = 6000;
const MIN_SPEED = 130; // px per second; the slow end is what makes low counts possible
const MAX_SPEED = 340;
const MIN_AXIS_SPEED = 60; // keeps the ball from sliding along a wall
const MIN_BOUNCES = 3;
const MAX_BOUNCES = 11;
const MIN_GAP_MS = 250; // two turns closer than this (a corner, say) are hard to count apart
const MIN_FEINTS = 1; // feints: the ball turns short of the wall, as if it had bounced
const MAX_FEINTS = 3;
const FEINT_CHANCE = 0.4; // per approach to a wall, until the planned number is reached
const FEINT_MIN_GAP_PX = 28; // how far from the wall a feint turns; also its clearance from every wall
const FEINT_MAX_GAP_PX = 70;
const QUIET_START_MS = 300;
const QUIET_END_MS = 200;

const BACKGROUND = [30, 30, 28];
const WALL = [90, 90, 84];

const DOT_GRID = 96; // the dots variant is drawn on a coarse grid and scaled up by the page
const DOT_TWINKLE = 1; // share of background dots re-rolled every frame; lower makes the ball easier to see
const DOT_LIGHT = [200, 200, 195];

// Three colours of equal brightness, so alternating between two of them does not visibly flash.
const RED = [255, 64, 64];
const GREEN = [0, 158, 0];
const BLUE = [120, 120, 255];
// Palette indexes each flicker ball alternates between, and the colour the eye blends them into.
const FLICKER_BALLS = [
  { frames: [2, 3], name: "orange", blend: [186, 122, 47] },
  { frames: [4, 2], name: "pink", blend: [202, 97, 190] },
  { frames: [3, 4], name: "blue", blend: [88, 141, 186] },
];

const VARIANTS = {
  plain: { radius: 9, balls: 1, speed: 1 },
  dots: { radius: 20, balls: 1, speed: 0.8 },
  flicker: { radius: 11, balls: 3, speed: 1 },
};

export const VARIANT_NAMES = Object.keys(VARIANTS);
export const PLAY_MS = LEAD_IN_CS * 10 + DURATION_MS;

// Runs the ball forward from a random start. At each step it either carries on to the next
// wall, or feints: it turns early, reflecting exactly as it would have off the wall it was
// heading for. Returns the straight segments of the path and when each hit and feint happens.
function attempt(rand, { radius, speed: speedScale }) {
  const LOW = BORDER + radius; // range of the ball's centre on each axis
  const HIGH = SIZE - LOW;
  const angle = rand() * Math.PI * 2;
  const speed = ((MIN_SPEED + rand() * (MAX_SPEED - MIN_SPEED)) / 1000) * speedScale; // px per ms
  const ball = {
    x: LOW + rand() * (HIGH - LOW),
    y: LOW + rand() * (HIGH - LOW),
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
  };
  const segments = [{ t: 0, ...ball }];
  const events = []; // { t, feint }
  const feintsWanted = MIN_FEINTS + Math.floor(rand() * (MAX_FEINTS - MIN_FEINTS + 1));
  let t = 0;
  let feints = 0;

  for (;;) {
    const toWall = (pos, v) => ((v > 0 ? HIGH - pos : pos - LOW) / Math.abs(v));
    const tx = toWall(ball.x, ball.vx);
    const ty = toWall(ball.y, ball.vy);
    const axis = tx < ty ? "x" : "y";
    let dt = Math.min(tx, ty);
    let feint = false;

    if (feints < feintsWanted && rand() < FEINT_CHANCE) {
      const gap = FEINT_MIN_GAP_PX + rand() * (FEINT_MAX_GAP_PX - FEINT_MIN_GAP_PX);
      const early = dt - gap / Math.abs(axis === "x" ? ball.vx : ball.vy);
      const at = { x: ball.x + ball.vx * early, y: ball.y + ball.vy * early };
      const clearOfWalls = [at.x, at.y].every((c) => c - LOW >= FEINT_MIN_GAP_PX && HIGH - c >= FEINT_MIN_GAP_PX);
      if (early >= MIN_GAP_MS && clearOfWalls) {
        dt = early;
        feint = true;
      }
    }

    t += dt;
    if (t > DURATION_MS) break;
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    if (axis === "x") ball.vx = -ball.vx;
    else ball.vy = -ball.vy;
    segments.push({ t, ...ball });
    events.push({ t, feint });
    if (feint) feints++;
  }

  return {
    segments,
    events,
    bounces: events.length - feints,
    feints,
    minAxisSpeed: Math.min(Math.abs(ball.vx), Math.abs(ball.vy)),
  };
}

// Keeps trying until the path is fair to count by eye.
function simulate(seedBytes, variant) {
  const rand = mulberry32(new DataView(seedBytes.buffer, seedBytes.byteOffset).getUint32(0));
  let motion;
  for (let i = 0; i < 2000; i++) {
    motion = attempt(rand, variant);
    const times = motion.events.map((e) => e.t);
    const countable =
      motion.minAxisSpeed * 1000 >= MIN_AXIS_SPEED * variant.speed &&
      motion.bounces >= MIN_BOUNCES &&
      motion.bounces <= MAX_BOUNCES &&
      motion.feints >= MIN_FEINTS &&
      times.every((time, k) => k === 0 || time - times[k - 1] >= MIN_GAP_MS) &&
      times[0] >= QUIET_START_MS &&
      times.at(-1) <= DURATION_MS - QUIET_END_MS;
    if (countable) break;
  }
  return motion;
}

function positionAt(motion, t) {
  const segment = motion.segments.findLast((s) => s.t <= t);
  return { x: segment.x + segment.vx * (t - segment.t), y: segment.y + segment.vy * (t - segment.t) };
}

const frameCount = DURATION_MS / (FRAME_CS * 10);

// Solid balls on a plain background. colours[k] is the palette index ball k shows on even and odd frames.
function renderSolid(motions, radius, palette, colours) {
  const gif = createGif(SIZE, SIZE, palette);
  const wall = palette.indexOf(WALL);
  const colourAt = (px, py, centres, frame) => {
    let colour = 0;
    for (let k = 0; k < centres.length; k++) {
      if ((px + 0.5 - centres[k].x) ** 2 + (py + 0.5 - centres[k].y) ** 2 <= radius ** 2) colour = colours[k][frame % 2];
    }
    return colour;
  };

  // First frame: the whole square with its walls.
  let centres = motions.map((m) => positionAt(m, 0));
  const first = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const onWall = x < BORDER || y < BORDER || x >= SIZE - BORDER || y >= SIZE - BORDER;
      first[y * SIZE + x] = onWall ? wall : colourAt(x, y, centres, 0);
    }
  }
  gif.addFrame(0, 0, SIZE, SIZE, first, LEAD_IN_CS);

  // Later frames: repaint only the rectangle covering every ball's old and new position.
  for (let i = 1; i <= frameCount; i++) {
    const next = motions.map((m) => positionAt(m, i * FRAME_CS * 10));
    const all = [...centres, ...next];
    const reach = radius + 1;
    const x0 = Math.max(BORDER, Math.floor(Math.min(...all.map((c) => c.x)) - reach));
    const y0 = Math.max(BORDER, Math.floor(Math.min(...all.map((c) => c.y)) - reach));
    const x1 = Math.min(SIZE - BORDER, Math.ceil(Math.max(...all.map((c) => c.x)) + reach));
    const y1 = Math.min(SIZE - BORDER, Math.ceil(Math.max(...all.map((c) => c.y)) + reach));
    const pixels = new Uint8Array((x1 - x0) * (y1 - y0));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) pixels[(y - y0) * (x1 - x0) + (x - x0)] = colourAt(x, y, next, i);
    }
    gif.addFrame(x0, y0, x1 - x0, y1 - y0, pixels, FRAME_CS);
    centres = next;
  }
  return gif.finish();
}

// The ball is a disc cut from a fixed sheet of random dots that travels with it; everything
// outside the disc is re-rolled each frame. Every frame is redrawn in full, so neither a
// single frame nor the difference between two frames shows where the ball is.
function renderDots(motion, radius, rand) {
  const G = DOT_GRID;
  const cell = SIZE / G;
  const r2 = (radius / cell) ** 2;
  const gif = createGif(G, G, [BACKGROUND, DOT_LIGHT, WALL, [0, 0, 0]]);
  const bit = () => (rand() < 0.5 ? 1 : 0);
  const sheet = Uint8Array.from({ length: G * G }, bit);
  const background = Uint8Array.from({ length: G * G }, bit);

  for (let i = 0; i <= frameCount; i++) {
    const centre = positionAt(motion, i * FRAME_CS * 10);
    const cx = Math.round(centre.x / cell);
    const cy = Math.round(centre.y / cell);
    const pixels = new Uint8Array(G * G);
    for (let y = 0; y < G; y++) {
      for (let x = 0; x < G; x++) {
        const at = y * G + x;
        if (rand() < DOT_TWINKLE) background[at] = bit();
        if (x === 0 || y === 0 || x === G - 1 || y === G - 1) pixels[at] = 2;
        else if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) pixels[at] = sheet[((y - cy + G) % G) * G + ((x - cx + G) % G)];
        else pixels[at] = background[at];
      }
    }
    gif.addFrame(0, 0, G, G, pixels, i === 0 ? LEAD_IN_CS : FRAME_CS);
  }
  return gif.finish();
}

const firstUint32 = (bytes) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);

// Plans one video. randomBytes(n) must return n fresh random bytes. Returns the answer
// (and, for flicker, which colour the question is about) plus a function that renders the GIF.
export function plan(name, randomBytes) {
  const variant = VARIANTS[name];
  const motions = Array.from({ length: variant.balls }, () => simulate(randomBytes(4), variant));
  const rand = mulberry32(firstUint32(randomBytes(4)));
  const target = Math.floor(rand() * variant.balls); // which ball the question is about
  const { bounces, feints } = motions[target];
  const answer = { bounces, feints };
  if (name === "flicker") {
    answer.colour = FLICKER_BALLS[target].name;
    answer.swatch = `rgb(${FLICKER_BALLS[target].blend.join(", ")})`;
  }

  const render = () => {
    if (name === "dots") return renderDots(motions[0], variant.radius, rand);
    if (name === "flicker") {
      const palette = [BACKGROUND, WALL, RED, GREEN, BLUE, [0, 0, 0], [0, 0, 0], [0, 0, 0]];
      return renderSolid(motions, variant.radius, palette, FLICKER_BALLS.map((b) => b.frames));
    }
    return renderSolid(motions, variant.radius, [BACKGROUND, [107, 155, 255], WALL, [0, 0, 0]], [[1, 1]]);
  };
  return { answer, render };
}
