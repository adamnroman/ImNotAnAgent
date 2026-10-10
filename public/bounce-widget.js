// One count-the-bounces test. The server picks the video and knows the answer; this code
// only shows it and sends the count.
//
//   BounceCaptcha.mount(container, { variant, title, intro, onPass })
//
// variant: "plain", "dots" or "flicker". onPass(token) is called with the pass token.
window.BounceCaptcha = (() => {
  const MARKUP = `
    <h2></h2>
    <p class="prompt"></p>
    <div class="stage">
      <img alt="" hidden>
      <button class="play primary" type="button">Play</button>
    </div>
    <form>
      <input type="number" inputmode="numeric" min="0" max="99" placeholder="Wall touches" required disabled>
      <button class="replay" type="button" disabled>Replay</button>
      <button class="primary" type="submit" disabled>Submit</button>
    </form>
    <div class="outcome">
      <div class="verdict"></div>
      <p class="detail"></p>
    </div>`;

  const post = (path, body) =>
    fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  function mount(container, { variant, title, intro, onPass }) {
    const section = document.createElement("section");
    section.className = "bounce-test";
    section.innerHTML = MARKUP;
    const el = (selector) => section.querySelector(selector);
    const parts = {
      prompt: el(".prompt"), img: el("img"), play: el(".play"), form: el("form"), answer: el("input"),
      replay: el(".replay"), submit: el("[type=submit]"), verdict: el(".verdict"), detail: el(".detail"),
    };
    el("h2").textContent = title;
    parts.prompt.textContent = intro;
    parts.img.alt = `${title}: a ball bouncing around a square`;

    let challenge, video, playMs, plays, unlockTimer;

    const setAnswering = (enabled) => {
      parts.answer.disabled = parts.replay.disabled = parts.submit.disabled = !enabled;
    };

    // A GIF without a loop marker plays once each time it is loaded.
    function play() {
      setAnswering(false);
      parts.img.src = `${video}?play=${plays++}`;
      clearTimeout(unlockTimer);
      unlockTimer = setTimeout(() => {
        setAnswering(true);
        parts.answer.focus();
      }, playMs);
    }

    function showOutcome(text, passed, detail = "") {
      setAnswering(false);
      parts.verdict.textContent = text;
      parts.verdict.className = "verdict " + (passed ? "pass" : "fail");
      parts.detail.textContent = detail;
      parts.play.textContent = "Try another";
      parts.play.hidden = false;
    }

    async function newChallenge() {
      parts.play.hidden = true;
      parts.verdict.textContent = parts.detail.textContent = "";
      parts.answer.value = "";
      try {
        const res = await post("/api/bounce/start", { variant });
        if (!res.ok) throw new Error();
        const data = await res.json();
        ({ challenge, video, playMs } = data);
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
      } catch {
        showOutcome("Could not reach the server.", false);
      }
    }

    parts.form.addEventListener("submit", async (e) => {
      e.preventDefault();
      setAnswering(false);
      try {
        const res = await post("/api/bounce/verify", { challenge, answer: Number(parts.answer.value) });
        const data = await res.json();
        if (!res.ok) return showOutcome("This challenge can no longer be answered.", false);
        const actual =
          data.bounces === undefined ? "" : `It touched a wall ${data.bounces} times and feinted ${data.feints} times.`;
        showOutcome(data.passed ? "Passed: likely human" : "Failed: wrong count", data.passed, actual);
        if (data.passed) onPass?.(data.token);
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
