// Prepares a fresh checkout for `wrangler dev`: `npm run setup` (also runs before `npm run dev`).
//   - creates .dev.vars with a random CAPTCHA_SECRET, if it does not exist
//   - renders the bounce videos and their answer key, if they do not exist
// Both stay out of git: the answer key would let anyone pass the bounce test.

import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const devVars = new URL(".dev.vars", root);
if (!existsSync(devVars)) {
  writeFileSync(devVars, `CAPTCHA_SECRET=${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  console.log("created .dev.vars with a random CAPTCHA_SECRET");
}
if (!existsSync(new URL("src/bounce-pool.json", root))) {
  console.log("rendering the bounce videos…");
  execFileSync(process.execPath, [new URL("tools/build-bounce-pool.mjs", root).pathname], { stdio: "inherit" });
}
