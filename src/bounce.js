// Count-the-bounces test. A ball bounces around a square and the viewer counts how many
// times it touches a wall; turns that stop short of the wall are feints and do not count.
// To pass, the count must be right and the way it was entered must look human (behaviour.js).
//
// The videos are rendered ahead of time by `npm run build:pool` (see tools/). The GIFs are
// static files with random names; their answers are in bounce-pool.json, which is bundled
// into the Worker and never served. Each challenge picks one video at random.
//
// Which video a challenge uses is never readable outside the Worker: the challenge token is
// encrypted, and the page loads the video from a URL made of that token (bounceVideo), not
// from the file's name. Otherwise the answers could be learnt once and replayed per video.
// A flicker video has an answer per ball; the colour to follow is drawn for each challenge,
// independently of the video, and every colour has the same set of answers across the pool,
// so being told the colour says nothing about the video or the count.

import pool from "./bounce-pool.json" with { type: "json" };
import { json, fail, seal, encrypt, decrypt } from "./tokens.js";
import { scoreBehaviour, validateBehaviour } from "./behaviour.js";
import { recordFailure } from "./limits.js";
import { collectTrace } from "./traces.js";

const PROMPTS = {
  plain: "Count the times the ball touches a wall.",
  dots: "A patch of dots moves like a ball. Count the times it touches a wall.",
  flicker: "Count the times the ball of this colour touches a wall.",
};
const MIN_ANSWER_MS = 6000; // the ball moves for this long, so no honest answer arrives sooner
const CHALLENGE_TTL_MS = 60000; // the page swaps in a new video when this runs out, like an authenticator code
const PASS_TOKEN_TTL_MS = 120000;

const randomBelow = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n;

export async function bounceStart(env, body, { site }) {
  const variant = body.variant ?? "plain";
  if (!Object.hasOwn(pool.videos, variant)) return fail(400, "unknown variant");
  const videos = pool.videos[variant];
  const video = videos[randomBelow(videos.length)];

  const colours = video.answers && Object.keys(video.answers);
  const colour = colours?.[randomBelow(colours.length)]; // flicker only: which ball to follow

  const challenge = await encrypt(env, "bounce", {
    id: crypto.randomUUID(),
    issuedAt: Date.now(),
    variant,
    video: video.id,
    colour,
    site,
  });
  return json({
    challenge,
    video: `/api/bounce/video/${challenge}.gif`,
    playMs: pool.playMs,
    expiresInMs: CHALLENGE_TTL_MS,
    prompt: PROMPTS[variant],
    colour, // flicker only: which blended colour to follow
    swatch: video.answers?.[colour].swatch,
  });
}

// The challenge, its video and the right answer, or null if the token is not ours or has run out.
async function loadChallenge(env, token) {
  const challenge = await decrypt(env, "bounce", token);
  const video = challenge && pool.videos[challenge.variant]?.find((v) => v.id === challenge.video);
  const answer = video?.answers ? video.answers[challenge.colour] : video;
  const age = challenge ? Date.now() - challenge.issuedAt : 0;
  return answer && age <= CHALLENGE_TTL_MS ? { challenge, video, answer, age } : null;
}

// GET /api/bounce/video/<challenge>.gif: the video for a challenge, while the challenge lasts.
// The file's validators (ETag, Last-Modified) are left out; they would identify the video.
export async function bounceVideo(env, request, token) {
  const loaded = await loadChallenge(env, token);
  if (!loaded) return fail(404, "not found");
  const file = await env.ASSETS.fetch(new URL(`/bounce-videos/${loaded.video.id}.gif`, request.url));
  if (!file.ok) return fail(404, "not found");
  return new Response(file.body, { headers: { "content-type": "image/gif", "cache-control": "no-store" } });
}

export async function bounceVerify(env, body, { ip }) {
  const loaded = await loadChallenge(env, body.challenge);
  if (!loaded) return fail(400, "challenge expired or invalid");
  const { challenge, answer, age } = loaded;
  if (!Number.isInteger(body.answer)) return fail(400, "answer must be a whole number");
  if (age < MIN_ANSWER_MS) return fail(400, "answered before the video could have finished");
  const behaviourError = validateBehaviour(body.behaviour);
  if (behaviourError) return fail(400, behaviourError);

  // One answer per challenge, so the count cannot be found by guessing.
  const usedKey = `used:${challenge.id}`;
  if (await env.USED.get(usedKey)) return fail(409, "challenge already answered");
  await env.USED.put(usedKey, "1", { expirationTtl: 600 });

  const behaviour = scoreBehaviour(body.behaviour, body.answer);
  const countRight = body.answer === answer.bounces;
  const passed = countRight && behaviour.humanEnough;

  // A failure says nothing about why, so a wrong guess teaches nothing about the count.
  const response = { passed };
  if (passed) {
    response.score = behaviour.score;
    response.token = await seal(env, "pass", {
      id: challenge.id,
      site: challenge.site,
      score: behaviour.score,
      expiresAt: Date.now() + PASS_TOKEN_TTL_MS,
    });
  } else {
    response.attemptsLeft = await recordFailure(env, ip);
  }
  // Answers and measurements help tuning, and hand a bot the answer key. Off in production.
  if (env.DEBUG_FEATURES === "true") {
    Object.assign(response, { bounces: answer.bounces, feints: answer.feints, countRight, behaviour });
  }
  // Labelled test sessions only (traces.js); undefined, and so left out, for everyone else.
  response.recorded = await collectTrace(env, body.collect, {
    test: "bounce", variant: challenge.variant, behaviour: body.behaviour, passed, countRight,
    score: behaviour.score, features: behaviour.features, signals: behaviour.signals,
  });
  return json(response);
}
