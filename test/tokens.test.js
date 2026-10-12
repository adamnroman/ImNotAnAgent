// Encrypted tokens: only the Worker can read or change what is inside.

import test from "node:test";
import assert from "node:assert/strict";
import { encrypt, decrypt, seal } from "../src/tokens.js";

const env = { CAPTCHA_SECRET: "test-secret" };
const payload = { id: "c0ffee", video: "0123456789abcdef", issuedAt: 1 };
const decode = (token) => Buffer.from(token, "base64url").toString("latin1");

test("an encrypted token decrypts to its payload", async () => {
  assert.deepEqual(await decrypt(env, "bounce", await encrypt(env, "bounce", payload)), payload);
});

test("an encrypted token does not show its contents", async () => {
  const token = await encrypt(env, "bounce", payload);
  for (const text of [token, decode(token)]) {
    assert.ok(!text.includes(payload.video));
    assert.ok(!text.includes("video"));
  }
  // A signed token, by contrast, is readable by whoever holds it.
  assert.ok(decode((await seal(env, "bounce", payload)).split(".")[0]).includes(payload.video));
});

test("the same payload encrypts differently each time", async () => {
  assert.notEqual(await encrypt(env, "bounce", payload), await encrypt(env, "bounce", payload));
});

test("a token is rejected for another kind, another secret, or after tampering", async () => {
  const token = await encrypt(env, "bounce", payload);
  assert.equal(await decrypt(env, "pass", token), null);
  assert.equal(await decrypt({ CAPTCHA_SECRET: "other-secret" }, "bounce", token), null);
  const bytes = Buffer.from(token, "base64url");
  for (const at of [0, 20, bytes.length - 1]) {
    const changed = Buffer.from(bytes);
    changed[at] ^= 1;
    assert.equal(await decrypt(env, "bounce", changed.toString("base64url")), null);
  }
});

test("things that are not tokens are rejected", async () => {
  for (const junk of [undefined, null, 42, "", "abc", "not a token!", await seal(env, "bounce", payload)]) {
    assert.equal(await decrypt(env, "bounce", junk), null);
  }
});
