# PS5 Watch

Screens **six Back Market marketplaces** for used PlayStation 5 consoles, publishes one
dashboard with everything on sale, and pushes a Telegram alert when a Good-or-better
console appears under **€450 / £400**.

Markets: 🇩🇪 Germany · 🇫🇷 France · 🇮🇹 Italy · 🇬🇧 UK · 🇧🇪 Belgium · 🇳🇱 Netherlands
Models: PlayStation 5 · PS5 Slim · PS5 Pro

> There is no Back Market Luxembourg — Back Market runs 17 country sites and LU isn't one
> of them. Belgium and the Netherlands cover that gap; both ship to Luxembourg.

## Running it

```bash
node scrape.mjs                        # full run: 18 pages, writes data.json
node scrape.mjs --probe de             # one market only
node scrape.mjs --probe de/playstation-5   # one page, prints result, writes nothing
node scrape.mjs --limit 2              # first 2 pages, for quick iteration
node scrape.mjs --no-notify            # scrape without sending Telegram messages
node selftest.mjs                      # offline checks — no network, no Chrome, no Telegram
./refresh.sh                           # run, commit and push to GitHub Pages
```

`PS5_DEBUG=1` prints every navigation attempt with the page title and URL — the fastest way
to see whether you are looking at a product page or at the challenge page.

Needs Google Chrome installed. Override its location with `CHROME_PATH` if it isn't in
the usual place.

## Changing the alert thresholds

Everything tunable is in the `CONFIG` block at the top of `scrape.mjs`, and each value
can also be set by environment variable without editing the file:

| Setting | Default | Env var |
|---|---|---|
| Max price, euro markets | `450` | `PS5_MAX_EUR` |
| Max price, UK | `400` | `PS5_MAX_GBP` |
| GBP→EUR rate (display only) | `1.17` | `PS5_GBP_EUR` |
| Best grade to alert on | Good (rank 3) | edit `maxGradeRank` |

```bash
PS5_MAX_EUR=520 node scrape.mjs     # loosen the cap for one run
```

The dashboard always shows **every** listing. The cap only decides what reaches your phone.

## Telegram setup (one time)

1. In Telegram, message **@BotFather** → `/newbot` → follow the prompts.
   Copy the token it gives you (looks like `8123456789:AAH…`).
2. Send any message to your new bot (it can't message you first).
3. Get your chat id:
   ```bash
   curl -s "https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates" | grep -o '"id":[0-9-]*' | head -1
   ```
4. Test it:
   ```bash
   TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… node notify.mjs
   ```
5. Add both as **GitHub Actions secrets** (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`)
   under Settings → Secrets and variables → Actions.

Without those env vars the scraper still runs and writes `data.json`; it just prints how
many alerts it suppressed. Credentials are never written to a file in this repo.

## How it works, and why

Back Market sits behind Cloudflare. Plain HTTP gets `403 bot-need-challenge` on every
product URL in every market, so this drives **real headless Chrome over the DevTools
Protocol** — the same approach as `../odyssey-watch`, zero npm dependencies.

Three details that took experimentation to get right:

- **The warm-up.** The first navigation to a domain absorbs the Cloudflare challenge and
  sits on "Just a moment…". It must be a *flat wait* — polling it, or bouncing through
  `about:blank` afterwards, loses the clearance and the next page hangs for 30s. After the
  warm-up, product pages load in about 2.5s.
- **Grades are read as numeric ids**, not words. `input[name="step-grades"]` carries Back
  Market's own grade ids (`12`=Good, `11`=Very good, `10`=Excellent), identical in all six
  languages. Nothing here matches "Hervorragend" or "Ottimo".
- **Sold out = no price parses.** A grade's label is either `Gut 599,00 €` or
  `Hervorragend Ausverkauft`. If no price comes out of it, that grade is out of stock —
  which needs no per-language table of sold-out phrases.
- **A model with no offers at all** renders with no grade picker *and* no JSON-LD. That is
  Back Market's fully-sold-out page, not a scraper failure, so it is reported as
  `unavailable` rather than an error. The PS5 Pro is in exactly this state in all six
  markets today. If the grades disappear but the JSON-LD is still there, that *is* a
  selector break and it errors loudly.

One fragile-looking line in `chrome()` is load-bearing: Chrome is launched with a fixed
`--remote-debugging-port` and `stdio: 'ignore'`. With `--remote-debugging-port=0` and a
piped stderr, every product page parks on `/testchallengepage` forever. That was bisected
against a working prototype; don't "tidy" it without re-running the probe.

Prices are parsed per market because the formats genuinely differ: `599,00 €` in
DE/FR/IT/BE/NL versus `£469.99` in the UK. `parsePrice()` is exported and unit-tested.

### What "a new listing" means here

The `/p/` master product page shows the **current winning offer per grade**, not every
seller's stock. So the unit tracked is `(market, model, storage, grade)`, and an alert
fires when one of those becomes available, changes seller, or drops in price. That's
enough to catch a cheap console quickly; it is not per-seller inventory, which Back
Market doesn't expose on these pages.

### Being a good citizen

Hourly, 18 pages, 1.5s apart, one browser per market. Only `robots.txt`-permitted `/p/`
pages are read — never `/search` or the internal `/bm/` API, both of which Back Market
disallows. Nothing is ever added to a basket or purchased.

## Files

| File | Purpose |
|---|---|
| `scrape.mjs` | The whole scraper. `CONFIG` at the top. |
| `notify.mjs` | Telegram push. One `fetch`, no dependencies. |
| `index.html` | Single-file dashboard. No build, no CDN. |
| `data.json` | Generated snapshot. Git history is the price log. |
| `seen.json` | Alerts already sent, so re-runs don't re-notify. |
| `selftest.mjs` | Offline checks for price parsing, thresholds and de-duplication. |
| `.github/workflows/refresh.yml` | Hourly cron + manual `workflow_dispatch` probe. |

## If it breaks

Run `node scrape.mjs --probe de/playstation-5` first — it prints the parsed result for one
page and writes nothing.

- **"page never cleared the challenge"** — Cloudflare has tightened up. Try a longer
  `CONFIG.warmupMs`. If that fails everywhere, the fallback is a paid stealth-scraping API.
- **"no grade options found"** — the grade radios vanished while the JSON-LD stayed, so
  Back Market changed the `step-grades` markup. (A genuinely sold-out model does *not*
  produce this error — it is reported as `unavailable` instead.)
- **"identity gate"** — a redirect served a different product; usually transient.
- **Grades showing as `Unknown (id N)`** — Back Market added a grade id. Add it to `GRADES`.
- **A run marked `verified: false`** publishes a warning banner on the dashboard rather
  than presenting stale prices as current.
