# Ball captcha

Hackathon prototypes of human checks, built as a Cloudflare Worker that runs locally with
`wrangler dev`. No API keys or paid services are involved.

- **Follow the ball** (`/`): keep the cursor on a moving ball. The server releases the path a
  leg at a time and scores the cursor trace for human-like lag, overshoot and jitter.
- **Count the bounces** (`/bounce`): count how often a ball touches a wall; some turns are
  feints that stop short of the wall. Three versions: a plain ball, a ball made of moving dots,
  and colour-flicker balls. Passing needs the right count and human-looking pointer and key input.
- **Embed script** (`/embed-demo`): one `<script>` tag that covers any page until the visitor
  passes the bounce test.

These are experiments, not production bot protection: a script that decodes the video frames
can still pass the bounce test.

## Run it

Needs Node 20 or later.

```sh
npm install
npm run dev
```

Then open http://localhost:8787 (follow the ball), http://localhost:8787/bounce (all three
bounce versions) or http://localhost:8787/embed-demo (the embed script on a sample page).

The first `npm run dev` also runs `npm run setup`, which:

- creates `.dev.vars` with a random `CAPTCHA_SECRET` for signing tokens, and
- renders 15 bounce videos into `public/bounce-videos/` with their answers in
  `src/bounce-pool.json`.

Neither is committed, since the answer key would let anyone pass. Run `npm run build:pool` to
render a fresh set.

## Other commands

- `npm test`: scoring tests for follow the ball, using simulated cursors.
- `npm run smoke`: end-to-end checks against the running dev server (pass with human-like
  input, failure with agent-like input, site binding, and the per-IP block).
- To see answers and raw measurements after each attempt while tuning, add
  `DEBUG_FEATURES=true` to `.dev.vars` and restart.

## Embedding

```html
<script src="http://localhost:8787/embed.js" data-variant="plain"></script>
```

`data-variant` is `plain`, `dots` or `flicker`. After a pass the page receives a
`ball-captcha:pass` event with a token. A server should POST `{"token": ..., "site": "<page origin>"}`
to `/api/siteverify` before trusting it; tokens are bound to the site and expire after two minutes.

## Rules the server enforces

- Each challenge accepts one answer and lasts one minute; the page then swaps in a new video.
- Three failed tests from one IP block it for ten minutes.
- Failures don't reveal the right answer.

## Layout

| Path | What it is |
|---|---|
| `src/index.js` | Worker routes and the follow-the-ball protocol |
| `src/scoring.js`, `src/path.js` | Follow-the-ball path and trace scoring |
| `src/bounce.js`, `src/behaviour.js` | Bounce challenges and input-behaviour scoring |
| `src/limits.js`, `src/tokens.js` | Per-IP failure limit, signed tokens |
| `tools/` | Video renderer, setup and smoke-test scripts |
| `public/` | Pages, widget and embed script |
| `recaptcha-v3/` | A reCAPTCHA v3 comparison page (needs your own keys in `recaptcha-v3/keys.env`) |
| `voice-captcha/` | Separate Python prototype: say a phrase, score human versus synthetic voice. It downloads large models (several hundred MB); see `voice-captcha/server.py` |
