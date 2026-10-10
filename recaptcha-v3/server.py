"""Localhost reCAPTCHA v3 test page.

Reads RECAPTCHA_SITE_KEY / RECAPTCHA_SECRET_KEY from keys.env next to this file
(or the environment). Serves a page that runs grecaptcha.execute on load and on
form submit, then verifies each token server-side and shows Google's response.
"""
import json
import os
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).parent
PORT = 8765


def load_keys():
    keys = {k: os.environ.get(k, "") for k in ("RECAPTCHA_SITE_KEY", "RECAPTCHA_SECRET_KEY")}
    env_file = HERE / "keys.env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            name, sep, value = line.partition("=")
            if sep and name.strip() in keys:
                keys[name.strip()] = value.strip().strip("\"'")
    return keys


PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>reCAPTCHA v3 test</title>
<script src="https://www.google.com/recaptcha/api.js?render=__SITE_KEY__"></script>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 16px; }
  input, button { font: inherit; padding: 8px 10px; }
  input { width: 260px; }
  table { border-collapse: collapse; width: 100%; margin-top: 16px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #ddd; vertical-align: top; }
  .score { font-weight: 700; font-size: 18px; }
  pre { margin: 0; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
</style>
</head>
<body>
<h1>reCAPTCHA v3 test</h1>
<p>A token is requested on page load (<code>action=homepage</code>) and on each form submit
(<code>action=submit</code>). Scores run from 0.0 (likely bot) to 1.0 (likely human).</p>

<form id="demo-form">
  <input id="name" name="name" placeholder="Type anything" autocomplete="off">
  <button id="submit-btn" type="submit">Submit</button>
</form>

<table>
  <thead><tr><th>#</th><th>Action</th><th>Score</th><th>Raw siteverify response</th></tr></thead>
  <tbody id="results"></tbody>
</table>

<script>
  const SITE_KEY = "__SITE_KEY__";
  window.recaptchaResults = [];

  async function check(action) {
    const row = document.createElement("tr");
    const n = document.getElementById("results").children.length + 1;
    row.innerHTML = `<td>${n}</td><td>${action}</td><td class="score">…</td><td><pre></pre></td>`;
    document.getElementById("results").appendChild(row);
    let result;
    try {
      const token = await grecaptcha.execute(SITE_KEY, { action });
      const res = await fetch("/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      result = await res.json();
    } catch (err) {
      result = { success: false, client_error: String(err && err.message || err) };
    }
    row.querySelector(".score").textContent = result.score ?? "n/a";
    row.querySelector("pre").textContent = JSON.stringify(result, null, 2);
    window.recaptchaResults.push({ action, ...result });
    console.log("[recaptcha]", action, JSON.stringify(result));
    return result;
  }

  grecaptcha.ready(() => check("homepage"));
  document.getElementById("demo-form").addEventListener("submit", (e) => {
    e.preventDefault();
    check("submit");
  });
</script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, body, content_type):
        data = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.split("?")[0] != "/":
            return self._send(404, "not found", "text/plain")
        keys = load_keys()
        if not keys["RECAPTCHA_SITE_KEY"]:
            return self._send(500, "RECAPTCHA_SITE_KEY not set in keys.env", "text/plain")
        self._send(200, PAGE.replace("__SITE_KEY__", keys["RECAPTCHA_SITE_KEY"]), "text/html; charset=utf-8")

    def do_POST(self):
        if self.path != "/verify":
            return self._send(404, "not found", "text/plain")
        length = int(self.headers.get("Content-Length", 0))
        token = json.loads(self.rfile.read(length) or b"{}").get("token", "")
        payload = urllib.parse.urlencode(
            {"secret": load_keys()["RECAPTCHA_SECRET_KEY"], "response": token}
        ).encode()
        try:
            with urllib.request.urlopen(
                "https://www.google.com/recaptcha/api/siteverify", data=payload, timeout=10
            ) as resp:
                body = resp.read().decode()
        except Exception as err:  # surface network failures to the page
            body = json.dumps({"success": False, "server_error": str(err)})
        self._send(200, body, "application/json")


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
