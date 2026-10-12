// The bounce challenge must not tell the client which video it was given: the answers are
// fixed per video, so a readable video id would let them be learnt once and replayed.
// Needs the rendered pool (`npm run setup`, which `npm test` runs first).

import test from "node:test";
import assert from "node:assert/strict";
import pool from "../src/bounce-pool.json" with { type: "json" };
import { bounceStart, bounceVideo, bounceVerify } from "../src/bounce.js";
import { decrypt, encrypt } from "../src/tokens.js";

const ids = Object.values(pool.videos).flat().map((v) => v.id);
const site = "https://shop.example";

function fakeEnv() {
  const kv = new Map();
  const requested = [];
  return {
    CAPTCHA_SECRET: "test-secret",
    USED: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v) },
    // Stands in for the static files; the real ones carry validators that identify the file.
    ASSETS: {
      fetch: async (url) => {
        requested.push(new URL(url).pathname);
        return new Response("GIF89a", { headers: { "content-type": "image/gif", etag: '"file-hash"' } });
      },
    },
    requested,
  };
}

const videoRequest = (path) => new Request(`https://captcha.example${path}`);
const tokenIn = (path) => path.match(/^\/api\/bounce\/video\/([\w-]+)\.gif$/)[1];

for (const variant of Object.keys(pool.videos)) {
  test(`${variant}: nothing sent to the client names the video`, async () => {
    const env = fakeEnv();
    for (let i = 0; i < 20; i++) {
      const start = await bounceStart(env, { variant }, { site });
      const data = await start.json();
      const video = await bounceVideo(env, videoRequest(data.video), tokenIn(data.video));
      assert.equal(video.status, 200);
      const sent = [JSON.stringify(data), JSON.stringify([...video.headers])];
      sent.push(...sent.map((s) => Buffer.from(s, "base64url").toString("latin1")));
      for (const id of ids) for (const text of sent) assert.ok(!text.includes(id));
      assert.equal(video.headers.get("etag"), null);

      // The Worker itself still knows which video it is.
      const { video: id } = await decrypt(env, "bounce", data.challenge);
      assert.ok(pool.videos[variant].some((v) => v.id === id));
      assert.equal(env.requested.at(-1), `/bounce-videos/${id}.gif`);
    }
  });
}

// What a challenge's video and right answer are, known only with the secret.
async function secretOf(env, data, variant) {
  const { video: id, colour } = await decrypt(env, "bounce", data.challenge);
  const video = pool.videos[variant].find((v) => v.id === id);
  return { id, bounces: (video.answers?.[colour] ?? video).bounces };
}

// Everything observable about a start response: each field's value, and how long it is
// (the encrypted token hides its contents but not their length).
function observations(data) {
  const seen = [];
  for (const [field, value] of Object.entries(data)) {
    if (value === undefined) continue;
    seen.push(`${field}=${value}`, `${field}.length=${String(value).length}`);
  }
  return seen;
}

for (const variant of Object.keys(pool.videos)) {
  test(`${variant}: no field of the start response narrows down the video or the answer`, async () => {
    const env = fakeEnv();
    const everyVideo = pool.videos[variant].map((v) => v.id).sort();
    const everyAnswer = [...new Set(pool.videos[variant].flatMap((v) => (v.answers ? Object.values(v.answers) : [v]).map((a) => a.bounces)))].sort();
    const DRAWS = 1500;
    const byObservation = new Map();
    for (let i = 0; i < DRAWS; i++) {
      const data = await (await bounceStart(env, { variant }, { site })).json();
      const secret = await secretOf(env, data, variant);
      for (const seen of observations(data)) {
        if (!byObservation.has(seen)) byObservation.set(seen, { count: 0, videos: new Set(), answers: new Set() });
        const group = byObservation.get(seen);
        group.count++;
        group.videos.add(secret.id);
        group.answers.add(secret.bounces);
      }
    }
    for (const [seen, group] of byObservation) {
      // A value seen once (the token, the video URL) is fresh per challenge and sorts nothing.
      if (group.count === 1) continue;
      assert.ok(group.count >= 100, `${seen} was seen only ${group.count} times: it singles out a few challenges`);
      assert.deepEqual([...group.videos].sort(), everyVideo, `${seen} narrows down the video`);
      assert.deepEqual([...group.answers].sort(), everyAnswer, `${seen} narrows down the answer`);
    }
  });
}

test("flicker: every colour has the same answers across the pool, one per video", () => {
  const colours = Object.keys(pool.videos.flicker[0].answers);
  const answersFor = (colour) => pool.videos.flicker.map((v) => v.answers[colour].bounces).sort();
  assert.ok(colours.length > 1);
  for (const colour of colours) {
    assert.deepEqual(answersFor(colour), answersFor(colours[0]));
    assert.equal(new Set(answersFor(colour)).size, pool.videos.flicker.length);
  }
  for (const video of pool.videos.flicker) assert.deepEqual(Object.keys(video.answers), colours);
});

test("flicker: the answer checked is the one for the colour asked about", async () => {
  const env = fakeEnv();
  const realNow = Date.now;
  try {
    for (const colour of Object.keys(pool.videos.flicker[0].answers)) {
      const video = pool.videos.flicker[0];
      const challenge = await encrypt(env, "bounce", { id: colour, issuedAt: realNow(), variant: "flicker", video: video.id, colour, site });
      const answer = video.answers[colour].bounces;
      const pointer = [];
      for (let t = 0; t < 7000; t += 16) pointer.push([t, 150 + Math.sin(t / 300) * 60 + (t % 48) / 8, 200 + Math.cos(t / 450) * 40 - (t % 80) / 8]);
      const behaviour = { pointer, keys: [...String(answer)].map((_, i) => [7600 + i * 180, 1]), videoEndAt: 6800, submitAt: 8200 };
      Date.now = () => realNow() + 8200;
      const result = await (await bounceVerify(env, { challenge, answer, behaviour }, { ip: "10.0.0.2" })).json();
      assert.equal(result.passed, true);
    }
  } finally {
    Date.now = realNow;
  }
});

test("the video is refused for a forged or expired challenge", async () => {
  const env = fakeEnv();
  const expired = await encrypt(env, "bounce", { id: "x", issuedAt: Date.now() - 61000, variant: "plain", video: pool.videos.plain[0].id, site });
  const forged = await encrypt({ CAPTCHA_SECRET: "guess" }, "bounce", { id: "x", issuedAt: Date.now(), variant: "plain", video: pool.videos.plain[0].id, site });
  for (const token of [expired, forged, "AAAA"]) {
    assert.equal((await bounceVideo(env, videoRequest(`/api/bounce/video/${token}.gif`), token)).status, 404);
  }
  assert.deepEqual(env.requested, []);
});

test("a right, human-looking answer still passes, once", async () => {
  const env = fakeEnv();
  const realNow = Date.now;
  try {
    const data = await (await bounceStart(env, { variant: "plain" }, { site })).json();
    const { video: id } = await decrypt(env, "bounce", data.challenge);
    const answer = pool.videos.plain.find((v) => v.id === id).bounces;
    const pointer = [];
    for (let t = 0; t < 7000; t += 16) pointer.push([t, 150 + Math.sin(t / 300) * 60 + (t % 48) / 8, 200 + Math.cos(t / 450) * 40 - (t % 80) / 8]);
    const body = {
      challenge: data.challenge,
      answer,
      behaviour: { pointer, keys: [...String(answer)].map((_, i) => [7600 + i * 180, 1]), videoEndAt: 6800, submitAt: 8200 },
    };

    assert.equal((await bounceVerify(env, body, { ip: "10.0.0.1" })).status, 400); // before the video could have finished
    Date.now = () => realNow() + 8200;
    const result = await (await bounceVerify(env, body, { ip: "10.0.0.1" })).json();
    assert.equal(result.passed, true);
    assert.ok(result.token);
    assert.equal((await bounceVerify(env, body, { ip: "10.0.0.1" })).status, 409);
  } finally {
    Date.now = realNow;
  }
});
