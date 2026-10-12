// End-to-end checks against a local `wrangler dev`: `node tools/smoke.mjs [base-url]`.
// Reads the answers from src/bounce-pool.json and decrypts challenges with the secret in
// .dev.vars, so it only works where the source is.
// Each check uses its own made-up client IP, which wrangler dev passes through.

import { readFileSync } from "node:fs";
import { decrypt } from "../src/tokens.js";

const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const pool = JSON.parse(readFileSync(new URL("../src/bounce-pool.json", import.meta.url)));
const env = { CAPTCHA_SECRET: readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/^CAPTCHA_SECRET=(.*)$/m)[1] };
const answerFor = async (challenge) => {
  const { video } = await decrypt(env, "bounce", challenge);
  return Object.values(pool.videos).flat().find((v) => v.id === video).bounces;
};
const ids = Object.values(pool.videos).flat().map((v) => v.id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, body, ip) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

// A wandering hand: curved pointer path, the answer typed key by key, a pause before submitting.
function humanBehaviour(answer) {
  const pointer = [];
  let x = 150, y = 200;
  for (let t = 0; t < 7000; t += 16) {
    x += Math.sin(t / 300) * 3 + (Math.random() - 0.5) * 2;
    y += Math.cos(t / 450) * 2 + (Math.random() - 0.5) * 2;
    pointer.push([t, +x.toFixed(1), +y.toFixed(1)]);
  }
  const keys = [...String(answer)].map((_, i) => [7600 + i * 180, 1]);
  return { pointer, keys, videoEndAt: 6800, submitAt: 8200 };
}

// What a coordinate-clicking agent leaves behind: one jump to the button, no typing.
const agentBehaviour = { pointer: [[100, 180, 210]], keys: [], videoEndAt: 6800, submitAt: 6900 };

async function attempt(ip, { site, answer, behaviour }) {
  const start = await post("/api/bounce/start", { variant: "plain", site }, ip);
  if (start.status !== 200) return { start: start.status, ...start.data };
  await sleep(6100);
  const right = await answerFor(start.data.challenge);
  const given = answer === "wrong" ? right + 1 : right;
  const verify = await post("/api/bounce/verify", {
    challenge: start.data.challenge,
    answer: given,
    behaviour: behaviour === "agent" ? agentBehaviour : humanBehaviour(given),
  }, ip);
  return { verify: verify.status, ...verify.data };
}

const site = "https://shop.example";
const results = await Promise.all([
  attempt("10.1.0.1", { site, answer: "right", behaviour: "human" }).then(async (r) => ({
    check: "right count, human-like input",
    ...r,
    siteverifySameSite: r.token && (await post("/api/siteverify", { token: r.token, site }, "x")).data,
    siteverifyOtherSite: r.token && (await post("/api/siteverify", { token: r.token, site: "https://evil.example" }, "x")).data,
  })),
  attempt("10.1.0.2", { site, answer: "right", behaviour: "agent" }).then((r) => ({ check: "right count, agent-like input", ...r })),
  (async () => {
    const ip = "10.1.0.3";
    const tries = [];
    for (let i = 0; i < 3; i++) tries.push(await attempt(ip, { site, answer: "wrong", behaviour: "human" }));
    const afterBlock = await post("/api/bounce/start", { variant: "plain", site }, ip);
    const otherIp = await post("/api/bounce/start", { variant: "plain", site }, "10.1.0.4");
    return {
      check: "three wrong answers from one IP",
      attemptsLeft: tries.map((t) => t.attemptsLeft),
      revealsCount: tries.some((t) => "bounces" in t),
      fourthStart: [afterBlock.status, afterBlock.data],
      differentIp: otherIp.status,
    };
  })(),
]);

// The video plays from its challenge URL, not from its file name, and nothing sent names the file.
const started = await post("/api/bounce/start", { variant: "plain", site }, "10.1.0.5");
const viaChallenge = await fetch(BASE + started.data.video);
const { video: id } = await decrypt(env, "bounce", started.data.challenge);
const byName = await fetch(`${BASE}/bounce-videos/${id}.gif`);
const sent = JSON.stringify([started.data, [...viaChallenge.headers]]);
results.push({
  check: "video served by challenge only",
  viaChallenge: [viaChallenge.status, viaChallenge.headers.get("content-type"), (await viaChallenge.arrayBuffer()).byteLength],
  byFileName: byName.status,
  idLeaked: ids.some((v) => sent.includes(v)),
});

for (const r of results) {
  if (r.token) r.token = `${r.token.slice(0, 12)}…`;
  console.log(JSON.stringify(r));
}
