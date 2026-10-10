// The ball's path: straight legs between random waypoints, with a sharp turn at
// each one. Generated on the server from a secret seed and released one leg at a time.

export const SIZE = 360; // logical square size in px
export const RADIUS = 24;
export const DURATION_MS = 8000;

const MARGIN = 44; // keeps waypoints away from the edges so there is room to overshoot
const MIN_LEG_PX = 90;
const MAX_LEG_PX = 220;
const MIN_SPEED = 110; // px per second
const MAX_SPEED = 190;
const MIN_TURN_COS = Math.cos((75 * Math.PI) / 180); // every turn is at least 75 degrees

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round2 = (v) => Math.round(v * 100) / 100;

// seedBytes: Uint8Array with at least 4 bytes. Returns [{x0, y0, x1, y1, t0, t1}] covering 0..DURATION_MS.
export function buildLegs(seedBytes) {
  const rand = mulberry32(new DataView(seedBytes.buffer, seedBytes.byteOffset).getUint32(0));
  const legs = [];
  let x = SIZE / 2;
  let y = SIZE / 2;
  let t = 0;
  let dir = null;

  while (t < DURATION_MS) {
    let pick = null;
    let fallback = null;
    for (let i = 0; i < 300 && !pick; i++) {
      const nx = MARGIN + rand() * (SIZE - 2 * MARGIN);
      const ny = MARGIN + rand() * (SIZE - 2 * MARGIN);
      const dist = Math.hypot(nx - x, ny - y);
      if (dist < MIN_LEG_PX || dist > MAX_LEG_PX) continue;
      fallback = { nx, ny, dist };
      if (dir && ((nx - x) * dir.x + (ny - y) * dir.y) / dist > MIN_TURN_COS) continue;
      pick = fallback;
    }
    pick ??= fallback ?? { nx: SIZE - x, ny: SIZE - y, dist: Math.hypot(SIZE - 2 * x, SIZE - 2 * y) || 1 };

    const speed = MIN_SPEED + rand() * (MAX_SPEED - MIN_SPEED);
    const duration = (pick.dist / speed) * 1000;
    const fraction = Math.min(1, (DURATION_MS - t) / duration); // clip the final leg at the end of the test
    const nx = round2(x + (pick.nx - x) * fraction);
    const ny = round2(y + (pick.ny - y) * fraction);
    const t1 = fraction < 1 ? DURATION_MS : round2(t + duration);

    legs.push({ x0: x, y0: y, x1: nx, y1: ny, t0: t, t1 });
    dir = { x: (pick.nx - x) / pick.dist, y: (pick.ny - y) / pick.dist };
    x = nx;
    y = ny;
    t = t1;
  }
  return legs;
}

export function legIndexAt(legs, t) {
  let i = 0;
  while (i < legs.length - 1 && t > legs[i].t1) i++;
  return i;
}

export function ballAt(legs, t) {
  const leg = legs[legIndexAt(legs, t)];
  const f = Math.max(0, Math.min(1, (t - leg.t0) / (leg.t1 - leg.t0)));
  return { x: leg.x0 + (leg.x1 - leg.x0) * f, y: leg.y0 + (leg.y1 - leg.y0) * f };
}
