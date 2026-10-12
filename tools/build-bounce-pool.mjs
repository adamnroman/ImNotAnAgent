// Pre-renders the count-the-bounces videos: `npm run build:pool`.
//
// Writes the GIFs to public/bounce-videos/ under random names, and their answers to
// src/bounce-pool.json, which only the Worker reads. Each variant gets PER_VARIANT videos
// with different answers drawn from COUNTS.
//
// A flicker video has three balls and the question can be about any of them. The page is
// told which colour to follow, so the colour must say nothing about the answer: every colour
// gets the same set of counts across the pool, each video using a different count per colour.

import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { FLICKER_COLOURS, PLAY_MS, VARIANT_NAMES, plan } from "./bounce-render.js";

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
  const counts = shuffled(COUNTS).slice(0, PER_VARIANT);
  videos[name] = counts.map((count, n) => {
    // Flicker: ball k of video n gets count n + k (wrapping), so each colour sees every count once.
    const wanted = FLICKER_COLOURS.map((_, k) => counts[(n + k) % counts.length]);
    for (let i = 0; i < MAX_TRIES; i++) {
      const { answer, render } = plan(name, randomBytes);
      const found = answer.answers ? FLICKER_COLOURS.map((c) => answer.answers[c].bounces) : [answer.bounces];
      if (found.some((bounces, k) => bounces !== (answer.answers ? wanted[k] : count))) continue;
      const id = randomBytes(8).toString("hex");
      const gif = render();
      writeFileSync(new URL(`${id}.gif`, VIDEO_DIR), gif);
      console.log(`${name}  ${Math.round(gif.length / 1024)} KB  ${found.join("/")} bounces`);
      return { id, ...answer };
    }
    throw new Error(`no ${name} video with ${count} bounces after ${MAX_TRIES} tries`);
  });
}

writeFileSync(POOL_FILE, JSON.stringify({ playMs: PLAY_MS, videos }, null, 2) + "\n");
