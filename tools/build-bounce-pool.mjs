// Pre-renders the count-the-bounces videos: `npm run build:pool`.
//
// Writes the GIFs to public/bounce-videos/ under random names, and their answers to
// src/bounce-pool.json, which only the Worker reads. Each variant gets PER_VARIANT videos
// with different answers drawn from COUNTS.

import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { PLAY_MS, VARIANT_NAMES, plan } from "./bounce-render.js";

const COUNTS = [4, 5, 6, 7, 8, 9, 10];
const PER_VARIANT = 5;
const MAX_TRIES = 50000;
const VIDEO_DIR = new URL("../public/bounce-videos/", import.meta.url);
const POOL_FILE = new URL("../src/bounce-pool.json", import.meta.url);

const shuffled = (items) =>
  items.map((item) => [randomBytes(4).readUInt32BE(), item]).sort((a, b) => a[0] - b[0]).map(([, item]) => item);

rmSync(VIDEO_DIR, { recursive: true, force: true });
mkdirSync(VIDEO_DIR, { recursive: true });

const videos = {};
for (const name of VARIANT_NAMES) {
  videos[name] = shuffled(COUNTS).slice(0, PER_VARIANT).map((count) => {
    for (let i = 0; i < MAX_TRIES; i++) {
      const { answer, render } = plan(name, randomBytes);
      if (answer.bounces !== count) continue;
      const id = randomBytes(8).toString("hex");
      const gif = render();
      writeFileSync(new URL(`${id}.gif`, VIDEO_DIR), gif);
      console.log(`${name}  ${Math.round(gif.length / 1024)} KB  ${answer.bounces} bounces, ${answer.feints} feints`);
      return { id, ...answer };
    }
    throw new Error(`no ${name} video with ${count} bounces after ${MAX_TRIES} tries`);
  });
}

writeFileSync(POOL_FILE, JSON.stringify({ playMs: PLAY_MS, videos }, null, 2) + "\n");
