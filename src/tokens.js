// Shared helpers: JSON responses and HMAC-signed tokens.

const encoder = new TextEncoder();

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const fail = (status, error, extra) => json({ error, ...extra }, status);

const toBase64Url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64Url = (text) =>
  Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

const hmacKey = (env) =>
  crypto.subtle.importKey("raw", encoder.encode(env.CAPTCHA_SECRET), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);

async function hmac(env, text) {
  return new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(env), encoder.encode(text)));
}

// Tokens are base64url(JSON) + "." + base64url(HMAC). `kind` stops one token type being used as another.
async function seal(env, kind, payload) {
  const body = toBase64Url(encoder.encode(JSON.stringify({ kind, ...payload })));
  return body + "." + toBase64Url(await hmac(env, body));
}

async function open(env, kind, token) {
  if (typeof token !== "string") return null;
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) return null;
  try {
    const valid = await crypto.subtle.verify("HMAC", await hmacKey(env), fromBase64Url(signature), encoder.encode(body));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body)));
    return payload.kind === kind ? payload : null;
  } catch {
    return null;
  }
}

async function sha256Hex(text) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export { json, fail, hmac, seal, open, sha256Hex };
