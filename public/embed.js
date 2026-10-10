// Ball captcha gate. Add to the <head> of any page:
//
//   <script src="https://YOUR-WORKER/embed.js" data-variant="plain"></script>
//
// data-variant is "plain" (default), "dots" or "flicker". The page is covered until the
// visitor passes the test, once per browser session. On a pass:
//   - document receives a "ball-captcha:pass" event whose detail.token is the pass token
//   - window.ballCaptchaToken holds the same token
//
// This only covers the page in the browser. To actually keep bots out, send the token to
// your server and have it POST {"token": ...} to https://YOUR-WORKER/api/siteverify before
// it returns anything worth protecting. Tokens expire two minutes after the pass.
(() => {
  const script = document.currentScript;
  const origin = new URL(script.src).origin;
  const variant = script.dataset.variant || "plain";
  const PASSED_KEY = "ball-captcha:passed";

  // Storage can be unavailable (private windows, blocked site data); then the test shows every time.
  const remembered = () => {
    try {
      return sessionStorage.getItem(PASSED_KEY) === "1";
    } catch {
      return false;
    }
  };
  if (remembered()) return;

  const cover = document.createElement("div");
  cover.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;background:#151514;display:flex;align-items:center;justify-content:center;";
  const frame = document.createElement("iframe");
  frame.src = `${origin}/widget?variant=${encodeURIComponent(variant)}`;
  frame.title = "Human check";
  frame.style.cssText = "border:0;width:min(380px,100vw);height:min(640px,100vh);border-radius:12px;";
  cover.append(frame);

  const root = document.documentElement;
  const previousOverflow = root.style.overflow;
  root.style.overflow = "hidden";
  root.append(cover);

  window.addEventListener("message", function onMessage(e) {
    if (e.origin !== origin || e.source !== frame.contentWindow || e.data?.type !== "ball-captcha:pass") return;
    window.removeEventListener("message", onMessage);
    try {
      sessionStorage.setItem(PASSED_KEY, "1");
    } catch {}
    window.ballCaptchaToken = e.data.token;
    cover.remove();
    root.style.overflow = previousOverflow;
    document.dispatchEvent(new CustomEvent("ball-captcha:pass", { detail: { token: e.data.token } }));
  });
})();
