// Shared helpers: JSON responses, HMAC-signed tokens and encrypted tokens.

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

// Encryption key, derived from the secret separately from the signing key.
const aesKey = async (env) =>
  crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: encoder.encode("ball-captcha token encryption") },
    await crypto.subtle.importKey("raw", encoder.encode(env.CAPTCHA_SECRET), "HKDF", false, ["deriveKey"]),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

// Encrypted tokens are base64url(IV + AES-GCM ciphertext): the holder can neither read nor
// alter the payload. `kind` is authenticated, so one token type cannot be used as another.
async function encrypt(env, kind, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(kind) },
    await aesKey(env),
    encoder.encode(JSON.stringify(payload)),
  );
  return toBase64Url(new Uint8Array([...iv, ...new Uint8Array(sealed)]));
}

async function decrypt(env, kind, token) {
  if (typeof token !== "string") return null;
  try {
    const bytes = fromBase64Url(token);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: encoder.encode(kind) },
      await aesKey(env),
      bytes.slice(12),
    );
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}

async function sha256Hex(text) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export { json, fail, hmac, seal, open, encrypt, decrypt, sha256Hex };
