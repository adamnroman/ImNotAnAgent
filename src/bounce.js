// Count-the-bounces test. A ball bounces around a square and the viewer counts how many
// times it touches a wall; turns that stop short of the wall are feints and do not count.
//
// The videos are rendered ahead of time by `npm run build:pool` (see tools/). The GIFs are
// static files with random names; their answers are in bounce-pool.json, which is bundled
// into the Worker and never served. Each challenge picks one video at random.

import pool from "./bounce-pool.json";
import { json, fail, seal, open } from "./tokens.js";

const PROMPTS = {
  plain: "Count the times the ball touches a wall.",
  dots: "A patch of dots moves like a ball. Count the times it touches a wall.",
  flicker: "Count the times the ball of this colour touches a wall.",
};
const MIN_ANSWER_MS = 6000; // the ball moves for this long, so no honest answer arrives sooner
const CHALLENGE_TTL_MS = 180000;
const PASS_TOKEN_TTL_MS = 120000;

export async function bounceStart(env, body) {
  const variant = body.variant ?? "plain";
  if (!Object.hasOwn(pool.videos, variant)) return fail(400, "unknown variant");
  const videos = pool.videos[variant];
  const video = videos[crypto.getRandomValues(new Uint32Array(1))[0] % videos.length];

  const challenge = await seal(env, "bounce", {
    id: crypto.randomUUID(),
    issuedAt: Date.now(),
    variant,
    video: video.id,
  });
  return json({
    challenge,
    video: `/bounce-videos/${video.id}.gif`,
    playMs: pool.playMs,
    prompt: PROMPTS[variant],
    colour: video.colour, // flicker only: which blended colour to follow
    swatch: video.swatch,
  });
}

export async function bounceVerify(env, body) {
  const challenge = await open(env, "bounce", body.challenge);
  const video = challenge && pool.videos[challenge.variant]?.find((v) => v.id === challenge.video);
  const age = challenge ? Date.now() - challenge.issuedAt : 0;
  if (!video || age > CHALLENGE_TTL_MS) return fail(400, "challenge expired or invalid");
  if (!Number.isInteger(body.answer)) return fail(400, "answer must be a whole number");
  if (age < MIN_ANSWER_MS) return fail(400, "answered before the video could have finished");

  // One answer per challenge, so the count cannot be found by guessing.
  const usedKey = `used:${challenge.id}`;
  if (await env.USED.get(usedKey)) return fail(409, "challenge already answered");
  await env.USED.put(usedKey, "1", { expirationTtl: 600 });

  const passed = body.answer === video.bounces;
  const response = { passed };
  if (passed) {
    response.token = await seal(env, "pass", {
      id: challenge.id,
      score: 100,
      expiresAt: Date.now() + PASS_TOKEN_TTL_MS,
    });
  }
  if (env.DEBUG_FEATURES === "true") Object.assign(response, { bounces: video.bounces, feints: video.feints });
  return json(response);
}
