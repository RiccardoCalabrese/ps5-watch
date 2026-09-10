# ps5-watch — notes for Claude

Personal project. Watches Back Market in six countries for a cheap used PS5.

## House style

Node ESM `.mjs`, **zero runtime dependencies**, no build step. JSON files as the
database. Single-file HTML front-end. Match this — don't reach for a framework or
an npm package without a real reason.

## How this project calls Parse

Parse (https://parse.bot) turns a website into a typed JSON API. We use it for
Back Market because Back Market blocks data-centre IPs, which is what stopped the
GitHub Actions version of the scraper from working.

- **Production path is Node, not Python.** Calling a built Parse API is one POST
  with one header, so `parse-client.mjs` does it with `fetch` and no dependencies.
  Use `callEndpoint(scraperId, endpoint, params)` from there.
- **Auth:** `PARSE_API_KEY` (starts `pmx_`), read from the environment or the
  gitignored `.env`. Never hard-coded, never committed. Keys: https://parse.bot/settings
- **REST shape:** base `https://api.parse.bot`, header `X-API-Key`, endpoints at
  `POST /scraper/{scraper_id}/{endpoint_name}`, build tasks at
  `GET /dispatch/tasks/{id}`. Source of truth: https://docs.parse.bot
- **The uv / `parse-sdk` setup here is for exploration only** — inspecting typed
  schemas and using the `parse` CLI while developing. It is not on the runtime path,
  so `pyproject.toml` and `.venv` are conveniences, not dependencies of the scraper.
  Run the CLI as `uv run parse …`.

Quick checks:
```bash
node parse-client.mjs task <taskId>              # build progress
node parse-client.mjs call <scraperId> <endpoint>  # one real call
uv run parse doctor --fix                        # if SDK imports misbehave
```

## Current state

The Back Market API is being built as task
`9e14f6fd-c5ee-4aa2-8773-9bbe92b2a483` ("Search for PlayStation 5 and
PlayStation 5 Slim products", backmarket.co.uk). Until it lands, `BACKMARKET`
in `parse-client.mjs` has TODO placeholders for the scraper id and endpoint name.

The existing `scrape.mjs` (real headless Chrome, six markets) still works and is
what the hourly launchd job runs. Parse is being evaluated as a way to move that
back into the cloud for 24/7 coverage — not yet a replacement.
