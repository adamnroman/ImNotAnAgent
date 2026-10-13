# ImNotAnAgent

Hackathon prototypes of human checks, built as a Cloudflare Worker. It runs locally with
`wrangler dev` and is deployed at https://imnotanagent.adamnroman.workers.dev. No API keys or
paid services are involved; it fits Cloudflare's free plan.

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

Needs Node 22 or later.

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

The page is never told which video it was given: the challenge token is encrypted, and the
video is loaded from a URL made of that token rather than from its file name. The video's
bytes still identify it, though, so the set should be re-rendered regularly.

In the colour-flicker version the page has to be told which colour to follow. That colour is
drawn for each challenge, separately from the video, and every colour has the same set of
answers across the videos, so it gives away neither the video nor the count. A set rendered
before this was the case has to be re-rendered (`npm run build:pool`).

## Other commands

- `npm test`: scoring tests for follow the ball (simulated cursors), and tests that the bounce
  challenge and its encrypted token give nothing away, and that trace collection stores only
  what it should, only with the key, and within its limits. Runs `npm run setup` first.
- `npm run smoke`: end-to-end checks against the running dev server (pass with human-like
  input, failure with agent-like input, site binding, the per-IP block, and the video being
  served only through its challenge).
- To see answers and raw measurements after each attempt while tuning, add
  `DEBUG_FEATURES=true` to `.dev.vars` and restart.

## Trace collection and privacy

The scoring bands (how far a pointer lags, how many moves it makes, how much its path bends,
how the answer is typed) are guesses. To tune them on real phones and desktops, the Worker can
record labelled test sessions. **This is off by default and never applies to ordinary
visitors**, including everyone who meets the test through the embed script.

An attempt is recorded only when all of these hold:

- `COLLECT_TRACES` is `"true"` (it is `"false"` in `wrangler.jsonc`) and the `COLLECT_KEY`
  secret is set (at least 16 characters);
- the page was opened from a link carrying that key and a label:
  `/bounce?collect=KEY&label=human-phone` (also `/widget` and `/`; labels are `human-phone`,
  `human-desktop` and `bot`).

The page then shows: "This session's pointer and key timings are recorded for tuning. No IP or
identity is stored." and, after each attempt, whether it was recorded.

**Recorded per attempt:**

- which test (`bounce` or `follow`) and which version (`plain`, `dots`, `flicker`), the label
  from the link, and the day (UTC date, no time of day);
- the viewport size in CSS pixels, and the kind of pointer (`mouse`, `touch` or `pen`);
- pointer or finger down, up and cancelled, and pointer moves, each as a time since the attempt
  started and a position;
- key presses and changes to the answer field, each as a time and whether it was a digit;
- when the video ended, when the answer was submitted, and how often the video was replayed;
- whether the attempt passed, whether the count was right (yes or no), the score, and the
  scorer's measurements and per-check suspicions;
- for follow the ball, the cursor trace and the path the ball took (so the trace can be scored
  again).

**Never recorded:** IP address, user agent, cookies, the site or page the test ran on, session
or challenge ids, which video was shown, the colour asked about, the right answer, or the
number typed. The collection key is not stored either. A record is built from the list above
field by field, so nothing else the browser sends can end up in it, and nothing about a trace
is written to logs.

**Limits:** records are deleted 30 days after the day they were made (on the next write and by
a daily scheduled run), a record over 150 KB is not stored, and at most 300 records are stored
per day.

Anyone holding a collection link can add records, so treat the link like a password and share
it only with the people doing the labelled sessions.

### Switching it on

Records go to a Cloudflare D1 database bound as `TRACES`. Once, to set it up:

```sh
npx wrangler d1 create imnotanagent-traces      # put the printed database_id in wrangler.jsonc
npx wrangler d1 migrations apply imnotanagent-traces --remote
openssl rand -hex 24 | npx wrangler secret put COLLECT_KEY
```

Then set `COLLECT_TRACES` to `"true"` in `wrangler.jsonc` and deploy; set it back to `"false"`
and deploy again when the sessions are done. To try it locally, run
`npx wrangler d1 migrations apply imnotanagent-traces --local` and add `COLLECT_TRACES=true`
and a `COLLECT_KEY` to `.dev.vars`.

### Using the records

- `npm run traces:export` writes the records to `data/traces.ndjson`, one per line (add
  `-- --local` for the local database). `data/` is gitignored; do not commit or share it.
- `npm run traces:analyse` scores those records again with the scoring code as it is now and
  prints, per test, label and pointer type, the pass rates and the 5th to 95th percentile of
  every measurement. Change a band, run it again, compare.

## Embedding

```html
<script src="https://imnotanagent.adamnroman.workers.dev/embed.js"></script>
```

By default the visitor chooses between the plain ball and the moving dots. Add
`data-variant="plain"`, `"dots"` or `"flicker"` to fix one version. After a pass the page receives a
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
| `src/limits.js`, `src/tokens.js` | Per-IP failure limit, signed and encrypted tokens |
| `src/traces.js`, `migrations/` | Opt-in trace collection and its database schema |
| `tools/` | Video renderer, setup and smoke-test scripts, trace export and analysis |
| `public/` | Pages, widget, embed script and the collection notice (`collect.js`) |
| `recaptcha-v3/` | A reCAPTCHA v3 comparison page (needs your own keys in `recaptcha-v3/keys.env`) |
| `voice-captcha/` | Separate Python prototype: say a phrase, score human versus synthetic voice. It downloads large models (several hundred MB); see `voice-captcha/server.py` |

## Deploying your own copy

```sh
npx wrangler kv namespace create USED   # put the printed id in wrangler.jsonc
npm run setup                            # renders the videos and answer key
openssl rand -hex 32 | npx wrangler secret put CAPTCHA_SECRET
npx wrangler deploy
```

`wrangler.jsonc` also names a D1 database for trace collection. Create it first (see
"Switching it on" above) or remove the `d1_databases` entry; the Worker runs without it.

## License

MIT; see [LICENSE](LICENSE).
