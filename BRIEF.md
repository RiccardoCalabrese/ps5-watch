# Back Market PS5 Watcher — handoff brief

You are taking over a working-but-misplaced project. Read this whole brief before
touching anything: it contains roughly two days of hard-won findings, several of
which are counter-intuitive and cost real time to discover. Re-deriving them is
pure waste; contradicting them without evidence will break things that currently work.

Repo: https://github.com/RiccardoCalabrese/ps5-watch (public)
Local: `~/Documents/PersonalOS/ps5-watch`
Dashboard: https://riccardocalabrese.github.io/ps5-watch/

---

## 1. What the user actually wants

Riccardo wants to buy a **cheap used PlayStation 5 in Good or better condition**.
Back Market prices differ a lot between countries, and good deals sell within hours.
He wants to be told fast, and to be able to browse everything on sale in one place.

### Already built and working
- Scrapes **6 markets**: DE, FR, IT, UK, BE, NL (there is **no Back Market Luxembourg** —
  17 country sites exist and LU is not one; `backmarket.lu` is an unrelated parked domain).
- **3 models**: `playstation-5`, `playstation-5-slim`, `playstation-5-pro`.
- Publishes a static dashboard and pushes a Telegram alert when a Good-or-better
  console appears under **€450 / £400**.

### NEW requirements — the reason you are being handed this
1. **Must run online, 24/7 — not on his Mac.** This is the headline requirement.
2. **A webpage alongside the Telegram bot** (a dashboard already exists; keep or improve it).
3. **The Telegram bot must be interactive.** He wants to message it and get back a
   live list of every PS5 on sale across all the marketplaces, on demand.

Requirement 3 is an architectural change: the current design is a one-shot cron
script. Answering messages needs either a persistent process polling `getUpdates`
or a webhook endpoint. Plan for that from the start.

---

## 2. Current state — what works, what is broken

**Works (verified against the live site):** `scrape.mjs` scraped 18/18 pages across
all six markets with zero errors, twice. Extraction, price parsing, grade mapping,
sold-out detection and the dashboard are all sound.

**Verified end to end:** Telegram delivery. Two real messages were sent and received,
including a correctly formatted alert with a working Buy link.

**BROKEN — the local schedule.** A launchd agent
(`~/Library/LaunchAgents/com.riccardo.ps5watch.plist`) runs `refresh.sh` hourly.
It has run **45 times and failed 45 times**, exit code 126:

```
/bin/bash: .../ps5-watch/refresh.sh: Operation not permitted
```

Root cause: **macOS TCC**. Unattended background processes cannot read
`~/Documents`, `~/Desktop` or `~/Downloads` without Full Disk Access. `data.json`
is 45 hours stale. Do not "fix" this by granting `/bin/bash` Full Disk Access —
that is a bad security trade for a price scraper. The project is moving off the
Mac anyway, which makes the problem moot. **Lesson: a script verified by running
it manually is NOT verified under launchd — the permission context differs.**

**Not configured:** `.env` was never created, so no Telegram token is present and
no alert would fire even if the schedule worked. The bot exists
(`@ps5watch_rc_bot`, chat id `7587141954`); its first token was shared in chat and
correctly revoked. A new token must go in the gitignored `.env`.

---

## 3. THE HARD PART — Back Market's bot protection

This is where the time went. Read carefully.

### What is blocked
- **Plain HTTP is dead.** Every product URL on every domain returns
  `403 {"code":"bot-need-challenge","challengePath":"/testchallengepage"}` to curl.
- **Sitemaps and the homepage ARE reachable with plain curl.** Useful for discovery:
  `/sitemap_master_product_pages.xml`, `/sitemap_landings.xml`, etc.
- **`robots.txt` disallows `*/search` and `*/bm/`** (the internal JSON API) on every
  domain. The `/p/` master product pages are permitted. **Use `/p/`.** The previous
  agent deliberately avoided the internal API for this reason. If you adopt a
  third-party service that scrapes via those internal endpoints, that is a
  deliberate decision to make explicitly with the user, not by accident.

### What works, and the exact technique
Real headless Chrome driven over the DevTools Protocol. The critical, non-obvious
sequence:

1. Navigate to the target. You get bounced to
   `/testchallengepage?next=<target>`.
2. **Dwell ~9 seconds.** The challenge page **never redirects onward by itself** —
   it was observed sitting there unchanged for 60s. Waiting for a redirect is a
   trap that produces an infinite hang.
3. **Navigate to the target again.** It now loads clean in ~2.5s.

So: navigate → dwell → re-navigate. Not navigate → wait-until-cleared.

### Four traps that each cost significant time

- **`--remote-debugging-port=0` with piped stderr makes every page fail.** With a
  fixed port and `stdio: 'ignore'`, pages clear on the first try. This was bisected
  against a working prototype. The mechanism was never explained — only that the
  behaviour is reproducible. **Do not "tidy" this line.**
- **Attach to Chrome's own initial tab.** Creating a new target via
  `Target.createTarget` also fails the challenge. Read the page target from
  `http://127.0.0.1:<port>/json` and connect to its `webSocketDebuggerUrl`.
- **Do not reuse Chrome profiles.** Chrome is SIGKILLed between markets, which
  leaves a stale `SingletonLock`; the next launch hangs on it. Use a throwaway
  `mkdtemp` profile per market.
- **Headless behaves identically to headful.** No xvfb needed. Headless alone is
  not what gets you blocked.

### GitHub Actions is blocked — this is the crux
Three `workflow_dispatch` runs across two markets (DE and UK): every page parks on
the challenge and never clears, while identical code succeeds from the user's home
connection.

A fingerprint theory was tested and **disproved**: the User-Agent was corrected to
match the runner's real platform (Linux, Chrome 152 — both machines run 152). Still
blocked. With Chrome version and platform matched, **the only remaining variable is
network origin. This is IP reputation against data-centre ranges.**

The hourly cron in `.github/workflows/refresh.yml` is therefore commented out;
`workflow_dispatch` is kept so the block can be cheaply re-tested. **Your central
problem is finding a network path that Back Market accepts and that is not the
user's Mac.**

---

## 4. Extraction — everything you need, already solved

Do not rewrite this. It is language-independent by design and covers six locales.

- **JSON-LD** (`script[type="application/ld+json"]`, `@type: Product`) gives
  `productID`, `name`, `storage`, `color`, and `offers` with `price`,
  `priceCurrency`, `availability`, `itemCondition`.
- **Grades are numeric IDs, not words.** `input[name="step-grades"]` carries Back
  Market's own grade ids, identical in every language:
  **`12` = Good, `11` = Very good, `10` = Excellent.** (Confirmed independently by
  Back Market's own `?l=10/11/12` links.) Never match "Hervorragend" or "Ottimo".
  Storage options are `input[name="step-storage"]`.
- **Sold out = no price parses out of the grade label.** Labels read either
  `Gut 599,00 €` or `Hervorragend Ausverkauft`. No per-language sold-out table needed.
- **A model with NO offers at all renders with no grade picker AND no JSON-LD.**
  That is a fully sold-out product page, not a scraping failure. The **PS5 Pro is in
  this state in all six markets** — treat it as `unavailable`, not an error. If the
  grades vanish but JSON-LD remains, that IS a real selector break.
- **Price formats differ and will silently produce nulls or 100×-wrong numbers:**
  - DE/FR/IT/BE/NL → `599,00 €` (symbol after, comma decimal, dot thousands)
  - UK → `£469.99` (symbol before, dot decimal, comma thousands)
  - UK labels carry trailing badges: `Excellent £514.00 Popular` — strip them.
  - `parsePrice()` is exported and covered by `selftest.mjs` (25 offline checks).
- Useful selector: `[data-qa="productpage-product-price"]`. Seller name appears in
  body text but is localized — best-effort only.

**What "a new listing" means:** the `/p/` page shows the current *winning offer per
grade*, not per-seller inventory. The tracked unit is
`(market, model, storage, grade) → {price, seller, available}`.

---

## 5. Measured costs — use these, they are real

Bandwidth was measured, not estimated:

| | |
|---|---|
| One product page | 0.73 MB |
| Warm-up, once per market | 1.60 MB |
| One full run (6 warm-ups + 18 pages) | **22.7 MB** |
| Hourly for 30 days | **~16 GB/month** |

Scripts dominate (0.51 MB of 0.73 MB). Blocking images and fonts saves only ~18%,
and you cannot block JS — the challenge *is* JS.

- **Residential proxies:** ~€2–8/GB → **€32–130/month** hourly. An earlier "€5–30"
  guess was wrong and was corrected; do not repeat it.
- **Parse.bot** (https://parse.bot, docs https://docs.parse.bot): Free 200 credits;
  Hobby $30/1k; Developer $100/5k; Team $300/20k. Per-call credit cost *varies*.
  Building a private API costs 75 credits, a revision 50. Only 12 pages per run are
  useful (PS5 + Slim × 6; Pro is sold out everywhere) → ~8,600 calls/month hourly,
  which lands on the $300 tier. **6 markets = 6 builds = 450 credits, exceeding the
  200 free credits.** Untested against Back Market — test the UK on the free tier
  before spending anything.

**Cheapest real option, if the user will accept it:** any always-on device on his
home connection (Raspberry Pi, NAS, old laptop). The block is on data-centre
networks, not on hardware. He has said he wants it off his Mac and online — but a
Pi at home is neither his Mac nor a data centre, so it is worth re-raising.

---

## 6. Your task

Get this running **online, 24/7, off his Mac**, with a **webpage** and an
**interactive Telegram bot**.

**Key architectural insight — separate the two concerns.** Only the *scraping*
needs an unblocked network path. The Telegram bot and the webpage can run anywhere,
free, on ordinary hosting. Do not let the scraping constraint dictate where the bot
lives. A likely shape:

- **Scraper** — wherever it can actually reach Back Market (this is the hard part).
  Writes results to shared storage.
- **Bot + web** — serverless or a cheap always-on host. A Telegram *webhook* is a
  better fit than `getUpdates` polling for on-demand queries, and works on free
  serverless tiers. On `/status` or similar, it reads the latest stored results and
  replies with everything in stock across all six markets.
- **Storage** — currently `data.json` committed to git, which doubles as the price
  history. Keep something equivalent.

**Options worth evaluating (none yet proven):**
- Parse.bot — partially set up already (see §7). Handles proxies/anti-bot server-side.
- A residential-proxy provider + any cloud host. Take a free trial and **test before
  subscribing**.
- Commercial unblockers (Bright Data Web Unlocker, ScrapingBee, Zyte, Browserless).
- A cheap VPS is almost certainly useless on its own — data-centre IP, same block.

**Test the block early and cheaply.** `node scrape.mjs --probe de/playstation-5`
runs one page, writes nothing, and exits non-zero if it fails. That is your
ten-second yes/no on any new network path. Do this *before* building anything on top.

---

## 7. Parse.bot integration — partially set up, untested

The user began this and it is unfinished. An API is being built for
**backmarket.co.uk only**: task `9e14f6fd-c5ee-4aa2-8773-9bbe92b2a483`
("Search for PlayStation 5 and PlayStation 5 Slim products").

Already in place:
- `parse-client.mjs` — zero-dependency Node client (`taskStatus`, `callEndpoint`),
  key read from env/`.env`, with TODOs for the scraper id and endpoint name.
- `pyproject.toml` + `.venv` with `parse-sdk` 0.2.0 (`uv run parse …`). This is for
  exploring typed schemas only — **not on the runtime path**, deliberately, because
  the project is zero-dependency Node.
- REST shape (verified against docs): base `https://api.parse.bot`, header
  `X-API-Key: pmx_…`, call `POST /scraper/{scraper_id}/{endpoint_name}`, build status
  `GET /dispatch/tasks/{id}`. **Task status requires auth** — it returns 401 without
  a key, contrary to the setup instructions calling it a "public" task.

Blocked on: `PARSE_API_KEY` is not set. Add it to the gitignored `.env`.

---

## 8. Conventions and preferences — follow these

- **Node ESM `.mjs`, zero runtime dependencies, no build step.** This is a firm
  house style across the user's projects. `scrape.mjs`, `notify.mjs`,
  `parse-client.mjs`, `selftest.mjs` and the single-file `index.html` all honour it.
  Do not introduce a framework or npm packages without a real reason.
- **JSON files as the database.** Git history is the price log.
- **Never commit secrets.** `.env` is gitignored; `.env.example` documents the shape.
- **When the user says "simpler", he wants a plainer explanation, not simpler code.**
- He responds well to being given evidence and real numbers, and explicitly asked not
  to be told something will work when it is unproven. He asked "can you ensure this
  works 100%?" about proxies — the honest answer was no, and he valued that. **Test
  first, recommend second.**
- Deal with one topic at a time; he will say so if you drift.

## 9. Verification standards — learn from the failure above

- `node selftest.mjs` — 25 offline checks (price parsing, thresholds, dedup,
  message rendering). No network, no Chrome, no Telegram. Run it after any change.
- `node scrape.mjs --probe <market>/<model>` — one page, writes nothing, exits
  non-zero on failure. Also wired to `workflow_dispatch`.
- **`PS5_DEBUG=1`** prints every navigation with title and URL — the fastest way to
  tell a product page from the challenge page.
- **Verify in the environment that will actually run it.** The launchd failure
  happened precisely because a manual run was treated as proof. A scheduled job, a
  container and a terminal have different permissions, network and identity.
- The scraper marks a run `verified: false` and the dashboard shows a stale-data
  banner rather than presenting old prices as current. Preserve that property:
  "everything is sold out" and "the scraper is broken" look identical from the outside.
