// One count-the-bounces test. The server picks the video and knows the answer; this code
// shows it, records how the visitor interacts (trusted pointer moves and key presses), and
// sends both with the count.
//
//   BounceCaptcha.mount(container, { variant, title, intro, site, onPass })
//
// variant: "plain", "dots" or "flicker". site: origin of the page the test protects
// (defaults to this page). onPass(token) is called with the pass token.
window.BounceCaptcha = (() => {
  const MARKUP = `
    <h2></h2>
    <p class="prompt"></p>
    <div class="stage">
      <img alt="" hidden>
      <button class="play primary" type="button">Play</button>
    </div>
    <form>
      <input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="2" autocomplete="off" placeholder="Wall touches" required disabled>
      <button class="replay" type="button" disabled>Replay</button>
      <button class="primary" type="submit" disabled>Submit</button>
    </form>
    <div class="cycle"><div class="cycle-bar"></div></div>
    <p class="cycle-text"></p>
    <div class="outcome">
      <div class="verdict"></div>
      <p class="detail"></p>
    </div>`;
  const MAX_POINTER_SAMPLES = 4000;

  const post = (path, body) =>
    fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const round1 = (v) => Math.round(v * 10) / 10;

  function mount(container, { variant, title, intro, site = location.origin, onPass }) {
    const section = document.createElement("section");
    section.className = "bounce-test";
    section.innerHTML = MARKUP;
    const el = (selector) => section.querySelector(selector);
    const parts = {
      prompt: el(".prompt"), img: el("img"), play: el(".play"), form: el("form"), answer: el("input"),
      replay: el(".replay"), submit: el("[type=submit]"), verdict: el(".verdict"), detail: el(".detail"),
      cycleBar: el(".cycle-bar"), cycleText: el(".cycle-text"),
    };
    el("h2").textContent = title;
    parts.prompt.textContent = intro;
    parts.img.alt = `${title}: a ball bouncing around a square`;

    let challenge, video, playMs, plays, unlockTimer, cycleTimer;
    let startedAt, behaviour; // behaviour times are ms since the challenge started

    const now = () => round1(performance.now() - startedAt);

    // Only events from a real input device are recorded; script-made events are not trusted.
    document.addEventListener("pointermove", (e) => {
      if (!e.isTrusted || !behaviour || behaviour.pointer.length >= MAX_POINTER_SAMPLES) return;
      behaviour.pointer.push([now(), round1(e.clientX), round1(e.clientY)]);
    });
    parts.answer.addEventListener("keydown", (e) => {
      if (!e.isTrusted || !behaviour || behaviour.keys.length >= 50) return;
      behaviour.keys.push([now(), /^[0-9]$/.test(e.key) ? 1 : 0]);
    });

    // Each challenge lasts a fixed time; when it runs out a new video replaces it.
    function startCycle(expiresInMs) {
      const endsAt = performance.now() + expiresInMs;
      clearInterval(cycleTimer);
      const tick = () => {
        const left = endsAt - performance.now();
        if (left <= 0) return newChallenge();
        parts.cycleBar.style.width = (left / expiresInMs) * 100 + "%";
        parts.cycleText.textContent = `New video in ${Math.ceil(left / 1000)}s`;
      };
      tick();
      cycleTimer = setInterval(tick, 250);
    }

    function stopCycle() {
      clearInterval(cycleTimer);
      parts.cycleBar.style.width = "0";
      parts.cycleText.textContent = "";
    }

    const setAnswering = (enabled) => {
      parts.answer.disabled = parts.replay.disabled = parts.submit.disabled = !enabled;
    };

    // A GIF without a loop marker plays once each time it is loaded.
    function play() {
      setAnswering(false);
      parts.img.src = `${video}?play=${plays++}`;
      clearTimeout(unlockTimer);
      unlockTimer = setTimeout(() => {
        behaviour.videoEndAt = now();
        setAnswering(true);
        parts.answer.focus();
      }, playMs);
    }

    function showOutcome(text, passed, detail = "", canRetry = true) {
      setAnswering(false);
      stopCycle();
      parts.verdict.textContent = text;
      parts.verdict.className = "verdict " + (passed ? "pass" : "fail");
      parts.detail.textContent = detail;
      parts.play.textContent = "Try another";
      parts.play.hidden = !canRetry;
    }

    const showBlocked = (seconds) =>
      showOutcome("Too many failed attempts.", false, `Try again in ${Math.ceil(seconds / 60)} minutes.`, false);

    async function newChallenge() {
      parts.play.hidden = true;
      parts.verdict.textContent = parts.detail.textContent = "";
      parts.answer.value = "";
      try {
        const res = await post("/api/bounce/start", { variant, site });
        if (res.status === 429) return showBlocked((await res.json()).retryAfterSeconds);
        if (!res.ok) throw new Error();
        const data = await res.json();
        ({ challenge, video, playMs } = data);
        startedAt = performance.now();
        behaviour = { pointer: [], keys: [], videoEndAt: 0, submitAt: 0 };
        parts.prompt.textContent = data.prompt;
        if (data.swatch) {
          const swatch = document.createElement("span");
          swatch.className = "swatch";
          swatch.style.background = data.swatch;
          parts.prompt.append(" ", swatch, `(${data.colour})`);
        }
        parts.img.hidden = false;
        plays = 0;
        play();
        startCycle(data.expiresInMs);
      } catch {
        showOutcome("Could not reach the server.", false);
      }
    }

    parts.form.addEventListener("submit", async (e) => {
      e.preventDefault();
      setAnswering(false);
      stopCycle();
      behaviour.submitAt = now();
      try {
        const res = await post("/api/bounce/verify", { challenge, answer: Number(parts.answer.value), behaviour });
        const data = await res.json();
        if (res.status === 429) return showBlocked(data.retryAfterSeconds);
        if (!res.ok) return showOutcome("This challenge can no longer be answered.", false);
        if (data.passed) {
          showOutcome("Passed: likely human", true, "", false);
          onPass?.(data.token);
          return;
        }
        const left = data.attemptsLeft === 1 ? "1 attempt left" : `${data.attemptsLeft} attempts left`;
        const debug = data.bounces === undefined ? "" : ` (Debug: ${data.bounces} touches, ${data.feints} feints, human score ${data.behaviour.score}.)`;
        showOutcome("Failed.", false, `${left}.${debug}`, data.attemptsLeft > 0);
      } catch {
        showOutcome("Could not reach the server.", false);
      }
    });
    parts.replay.addEventListener("click", play);
    parts.play.addEventListener("click", newChallenge);

    container.append(section);
  }

  return { mount };
})();
