// Captcha API. Static pages are served from ./public; this Worker handles /api/*.
//
// Follow-the-ball test (public/index.html):
//   POST /api/start          -> a signed session, the first leg of the ball's path
//   POST /api/leg            -> commit the cursor trace so far, receive the next leg
//   POST /api/verify         -> submit the rest of the trace, receive the score and a pass token
// Count-the-bounces test (public/bounce.html, and public/embed.js for other sites): see bounce.js
//   POST /api/bounce/start   -> a signed challenge and the URL of its pre-rendered video
//   POST /api/bounce/verify  -> check the answer, receive a pass token
// Both:
//   POST /api/siteverify     -> for the protected site's backend: check a pass token
//
// Pass tokens are bound to the site the test ran for, and siteverify only accepts a token
// for the site it was issued to. After three failed tests an IP is blocked for ten minutes.
//
// In the follow-the-ball test the path is derived from a secret, so the client only ever
// knows the legs it has been given. Each leg is released shortly before the ball reaches it,
// and only in exchange for the cursor trace up to that moment, so a script cannot see the
// whole path and then fabricate a trace to match. Sessions are stateless (HMAC-signed); KV
// only records which sessions have already been scored, so a result cannot be replayed.

import { SIZE, RADIUS, DURATION_MS, buildLegs } from "./path.js";
import { scoreTrace, validateTrace } from "./scoring.js";
import { json, fail, hmac, seal, open, sha256Hex } from "./tokens.js";
import { bounceStart, bounceVerify } from "./bounce.js";
import { blockedResponse, isBlocked, recordFailure } from "./limits.js";

const LEAD_MS = 350; // how early the next leg is released
const MAX_BEHIND_MS = 700; // a commit must cover the trace up to this close to "now"
const VERIFY_GRACE_MS = 5000; // how long after the test ends the final submission is accepted
const PASS_TOKEN_TTL_MS = 120000;
const MAX_BODY_BYTES = 400000;
const MAX_SEGMENT_SAMPLES = 1500;

const legsFor = async (env, session) => buildLegs(await hmac(env, `path|${session.id}|${session.startedAt}`));

// Samples are [t, x, y]; t must not go backwards and must stay inside [from, to].
function segmentError(samples, from, to) {
  if (!Array.isArray(samples) || samples.length > MAX_SEGMENT_SAMPLES) return "bad segment";
  let last = from;
  for (const s of samples) {
    if (!Array.isArray(s) || s.length !== 3 || !s.every(Number.isFinite)) return "bad sample";
    if (s[0] < last || s[0] > to) return "sample outside its segment";
    last = s[0];
  }
  return null;
}

async function start(env, body, { site }) {
  const session = { id: crypto.randomUUID(), startedAt: Date.now(), site };
  const legs = await legsFor(env, session);
  return json({
    session: await seal(env, "session", session),
    chain: await seal(env, "chain", { id: session.id, n: 0, upTo: 0, hash: "" }),
    leg: legs[0],
    last: legs.length === 1,
    size: SIZE,
    radius: RADIUS,
    durationMs: DURATION_MS,
    leadMs: LEAD_MS,
  });
}

// Loads and cross-checks the session and chain tokens that every later request carries.
async function loadSession(env, body) {
  const session = await open(env, "session", body.session);
  const chain = await open(env, "chain", body.chain);
  if (!session || !chain || chain.id !== session.id) return null;
  return { session, chain, legs: await legsFor(env, session), elapsed: Date.now() - session.startedAt };
}

async function nextLeg(env, body) {
  const loaded = await loadSession(env, body);
  if (!loaded) return fail(400, "invalid session");
  const { session, chain, legs, elapsed } = loaded;

  const n = chain.n + 1;
  if (n >= legs.length) return fail(400, "no more legs");
  const releaseAt = legs[n].t0 - LEAD_MS;
  if (elapsed < releaseAt) return fail(425, "too early", { retryInMs: Math.ceil(releaseAt - elapsed) });

  const { upTo, samples } = body;
  if (!Number.isFinite(upTo) || upTo < chain.upTo || upTo > elapsed + 100) return fail(400, "bad commit time");
  if (upTo < elapsed - MAX_BEHIND_MS) return fail(400, "trace commit is too far behind");
  const error = segmentError(samples, chain.upTo, upTo);
  if (error) return fail(400, error);

  return json({
    leg: legs[n],
    last: n === legs.length - 1,
    chain: await seal(env, "chain", {
      id: session.id,
      n,
      upTo,
      hash: await sha256Hex(chain.hash + JSON.stringify(samples)),
    }),
  });
}

async function verify(env, body, { ip }) {
  const loaded = await loadSession(env, body);
  if (!loaded) return fail(400, "invalid session");
  const { session, chain, legs, elapsed } = loaded;

  if (chain.n !== legs.length - 1) return fail(400, "test not finished");
  if (elapsed < DURATION_MS - 200 || elapsed > DURATION_MS + VERIFY_GRACE_MS) return fail(400, "submitted outside the test window");

  // The committed segments must be exactly what was sent while the test ran.
  const { segments } = body;
  if (!Array.isArray(segments) || segments.length !== legs.length) return fail(400, "bad segments");
  let hash = "";
  for (const committed of segments.slice(0, -1)) hash = await sha256Hex(hash + JSON.stringify(committed));
  if (hash !== chain.hash) return fail(400, "trace does not match what was committed");
  const error = segmentError(segments.at(-1), chain.upTo, DURATION_MS + 50);
  if (error) return fail(400, error);

  const trace = segments.flat();
  const traceError = validateTrace(trace);
  if (traceError) return fail(400, traceError);

  const usedKey = `used:${session.id}`;
  if (await env.USED.get(usedKey)) return fail(409, "session already scored");
  await env.USED.put(usedKey, "1", { expirationTtl: 600 });

  const result = scoreTrace(legs, trace);
  const response = {
    passed: result.passed,
    score: result.score,
    botProbability: result.botProbability,
    threshold: result.threshold,
  };
  if (result.passed) {
    response.token = await seal(env, "pass", {
      id: session.id,
      site: session.site,
      score: result.score,
      expiresAt: Date.now() + PASS_TOKEN_TTL_MS,
    });
  } else {
    response.attemptsLeft = await recordFailure(env, ip);
  }
  // Measurements help tune the thresholds, and help an attacker tune a bot. Off in production.
  if (env.DEBUG_FEATURES === "true") {
    response.features = result.features;
    response.signals = result.signals;
  }
  return json(response);
}

// body: { token, site } where site is the origin of the page that ran the test, e.g. "https://example.com".
async function siteVerify(env, body) {
  const pass = await open(env, "pass", body.token);
  if (!pass || pass.expiresAt < Date.now()) return json({ success: false, error: "invalid or expired token" });
  if (pass.site !== body.site) return json({ success: false, error: "token was issued for a different site" });
  return json({ success: true, score: pass.score, id: pass.id, site: pass.site });
}

// The origin a test is run for: the embedding site if the page says so, else the caller's origin.
function siteFor(body, request, url) {
  if (typeof body.site === "string") {
    try {
      const origin = new URL(body.site).origin;
      if (origin === body.site) return origin;
    } catch {}
  }
  return request.headers.get("origin") ?? url.origin;
}

// Starting or answering a test is refused while the caller's IP is blocked.
const LIMITED = new Set(["/api/start", "/api/verify", "/api/bounce/start", "/api/bounce/verify"]);

const routes = {
  "POST /api/start": start,
  "POST /api/leg": nextLeg,
  "POST /api/verify": verify,
  "POST /api/siteverify": siteVerify,
  "POST /api/bounce/start": bounceStart,
  "POST /api/bounce/verify": bounceVerify,
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const handler = routes[`${request.method} ${url.pathname}`];
    if (!handler) return fail(404, "not found");
    if (!env.CAPTCHA_SECRET) return fail(500, "CAPTCHA_SECRET is not set");

    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return fail(413, "body too large");
    let body = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        return fail(400, "body is not JSON");
      }
    }
    if (body === null || typeof body !== "object") return fail(400, "body is not an object");

    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    if (LIMITED.has(url.pathname) && (await isBlocked(env, ip))) return json(blockedResponse, 429);
    return handler(env, body, { ip, site: siteFor(body, request, url) });
  },
};
