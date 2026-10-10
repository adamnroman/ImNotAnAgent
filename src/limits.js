// Per-IP failure limit: after MAX_FAILURES failed tests an IP is blocked for BLOCK_SECONDS.
// Each failure restarts the block window. Counts live in the USED KV namespace.

const MAX_FAILURES = 3;
const BLOCK_SECONDS = 600;

const key = (ip) => `fails:${ip}`;

export async function failuresFor(env, ip) {
  return Number((await env.USED.get(key(ip))) ?? 0);
}

export const isBlocked = async (env, ip) => (await failuresFor(env, ip)) >= MAX_FAILURES;

export const blockedResponse = { error: "too many failed attempts", retryAfterSeconds: BLOCK_SECONDS };

// Records a failure and returns how many attempts the IP has left before it is blocked.
export async function recordFailure(env, ip) {
  const failures = (await failuresFor(env, ip)) + 1;
  await env.USED.put(key(ip), String(failures), { expirationTtl: BLOCK_SECONDS });
  return Math.max(0, MAX_FAILURES - failures);
}
