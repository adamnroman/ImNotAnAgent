// Opt-in trace collection for labelled test sessions, used to tune the scoring. It only does
// anything when the page was opened from a link carrying the collection key:
//
//   /bounce?collect=KEY&label=human-phone     (labels: human-phone, human-desktop, bot)
//
// and the server confirms the key (collection is off by default). The visitor is then told,
// and each attempt is sent with a little more than the test itself needs: the viewport size,
// the kind of pointer, where and when the pointer or finger went down and up, and when the
// answer field changed (whether by a digit, never what was typed). See the README.
//
//   const recorder = TraceCollection.attach({ noticeIn, input, position });
//   recorder.begin(startedAt)     a new attempt; times are ms since startedAt (performance.now()),
//                                 negative for the taps just before it
//   recorder.payload({ replays }) what to send as `collect` with the answer; undefined when off
//   recorder.result(recorded)     show whether the server stored the attempt
window.TraceCollection = (() => {
  const NOTICE = "This session's pointer and key timings are recorded for tuning. No IP or identity is stored.";
  const OFF = "Trace collection is off or this link is not valid. Nothing is recorded.";
  const MAX_TAPS = 500;
  const MAX_INPUTS = 50;
  const BEFORE_START_MS = 10000; // taps this soon before an attempt belong to it (pressing Play, landing on the ball)
  const KINDS = { pointerdown: 0, pointerup: 1, pointercancel: 2 };

  const params = new URLSearchParams(location.search);
  const key = params.get("collect");
  const label = params.get("label");
  const round1 = (v) => Math.round(v * 10) / 10;

  // Asked once per page, however many tests it shows.
  const confirmed = !key
    ? Promise.resolve(false)
    : fetch("/api/collect/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, label }) })
        .then((res) => (res.ok ? res.json() : {}))
        .then((data) => data.collecting === true)
        .catch(() => false);

  // noticeIn: element the notice is added to. input: the answer field, if the test has one.
  // position: maps a pointer event to the [x, y] to record (default: its place in the viewport).
  function attach({ noticeIn, input, position = (e) => [e.clientX, e.clientY] }) {
    let on = false;
    let startedAt = null;
    let taps = []; // times are performance.now() until sent
    let inputs = [];
    // "mouse", "touch" or "pen": a guess from the device until the first pointer event.
    let pointerType = matchMedia("(pointer: coarse)").matches ? "touch" : "mouse";
    const notice = document.createElement("p");
    notice.className = "collect-notice";
    const now = () => round1(performance.now() - startedAt);

    function onPointer(e) {
      if (!e.isTrusted) return; // like the tests, only real input devices are recorded
      if (e.pointerType) pointerType = e.pointerType;
      if (!(e.type in KINDS) || taps.length >= MAX_TAPS) return;
      const [x, y] = position(e);
      taps.push([KINDS[e.type], performance.now(), round1(x), round1(y)]);
    }

    if (key) {
      confirmed.then((collecting) => {
        on = collecting;
        notice.textContent = on ? NOTICE : OFF;
        noticeIn.append(notice);
        if (!on) return;
        for (const type of ["pointerdown", "pointerup", "pointercancel", "pointermove"]) {
          document.addEventListener(type, onPointer, { passive: true });
        }
        // Phone keyboards often report no usable key, so the field's changes are timed as well.
        input?.addEventListener("input", (e) => {
          if (!e.isTrusted || startedAt === null || inputs.length >= MAX_INPUTS) return;
          inputs.push([now(), /^[0-9]$/.test(e.data ?? "") ? 1 : 0]);
        });
      });
    }

    return {
      begin(at) {
        startedAt = at;
        taps = taps.filter(([, t]) => t >= at - BEFORE_START_MS);
        inputs = [];
        if (on) notice.textContent = NOTICE;
      },
      payload(extra = {}) {
        if (!on || startedAt === null) return undefined;
        const sinceStart = taps.map(([kind, t, x, y]) => [kind, round1(t - startedAt), x, y]);
        return { key, label, viewport: [innerWidth, innerHeight], pointerType, taps: sinceStart, inputs, ...extra };
      },
      result(recorded) {
        if (on) notice.textContent = `${NOTICE} ${recorded ? "This attempt was recorded." : "This attempt was not recorded."}`;
      },
    };
  }

  return { attach };
})();
