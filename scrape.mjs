#!/usr/bin/env node
// Back Market PS5 watcher — screens six national marketplaces for used PlayStation 5s.
//
// Why it's built this way (all verified against the live site, 8 Sep 2026):
//
//  - Back Market is behind Cloudflare. Plain HTTP gets 403 {"code":"bot-need-challenge"}
//    on every product URL, on every domain. So we drive real Chrome over the DevTools
//    Protocol, the same approach as ../odyssey-watch.
//  - The FIRST navigation to a domain absorbs the Cloudflare challenge and sits on
//    "Just a moment…". The SECOND loads clean in ~2.5s. That warm-up is the whole trick.
//    Headless behaves identically to headful, so this runs fine in CI without xvfb.
//  - robots.txt disallows */search and the internal */bm/ API. The /p/ master product
//    pages are permitted, and the same three slugs exist in every market. So we use those.
//  - Grades are read from `input[name="step-grades"]`, whose VALUES are stable numeric
//    Back Market grade ids (12=Good, 11=Very good, 10=Excellent) and identical across
//    locales. We never match localized words like "Hervorragend" or "Ottimo".
//  - A grade is sold out exactly when no price parses out of its label. Also
//    language-independent — no per-locale "Ausverkauft"/"Sold out" table to maintain.
//
// We only ever read public catalogue pages. Nothing is added to a basket or bought.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notifyAll } from './notify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_PATH
  || (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : 'google-chrome');
const EXTRA_FLAGS = process.platform === 'darwin' ? [] : ['--no-sandbox', '--disable-dev-shm-usage'];

// The User-Agent must match the platform we are actually running on. Headless Chrome's
// own UA says "HeadlessChrome", which is an instant tell, so we do have to override it —
// but claiming macOS while running on Linux is a WORSE tell, because everything else the
// page can see (navigator.platform, the WebGL renderer, the font list) still says Linux.
// Back Market refused GitHub's Linux runners while accepting the same code on macOS.
const UA = process.platform === 'darwin'
  ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
  : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG — everything tunable lives here.
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG = {
  // Alert thresholds, in each market's own currency.
  maxPriceEur: Number(process.env.PS5_MAX_EUR || 450),
  maxPriceGbp: Number(process.env.PS5_MAX_GBP || 400),

  // Alert on this grade or better. 3 = Good. (See GRADES below.)
  maxGradeRank: 3,

  // Fixed GBP->EUR rate, only used to make the UK column sortable against the
  // euro ones. Deliberately not a live FX call: it just needs to rank correctly.
  gbpToEur: Number(process.env.PS5_GBP_EUR || 1.17),

  // Sanity band. A PS5 outside this is a broken selector, not a bargain.
  minPlausible: 80,
  maxPlausible: 1500,

  pageDelayMs: 1500,     // between product pages
  dwellMs: 9000,         // time spent on a page before judging it; also what clears the challenge
};

export const MARKETS = [
  { key: 'de', country: 'Germany',     host: 'www.backmarket.de',    locale: 'de-de', lang: 'de-DE', currency: 'EUR', symbolBefore: false, decimal: ',' },
  { key: 'fr', country: 'France',      host: 'www.backmarket.fr',    locale: 'fr-fr', lang: 'fr-FR', currency: 'EUR', symbolBefore: false, decimal: ',' },
  { key: 'it', country: 'Italy',       host: 'www.backmarket.it',    locale: 'it-it', lang: 'it-IT', currency: 'EUR', symbolBefore: false, decimal: ',' },
  { key: 'uk', country: 'UK',          host: 'www.backmarket.co.uk', locale: 'en-gb', lang: 'en-GB', currency: 'GBP', symbolBefore: true,  decimal: '.' },
  { key: 'be', country: 'Belgium',     host: 'www.backmarket.be',    locale: 'fr-be', lang: 'fr-BE', currency: 'EUR', symbolBefore: false, decimal: ',' },
  { key: 'nl', country: 'Netherlands', host: 'www.backmarket.nl',    locale: 'nl-nl', lang: 'nl-NL', currency: 'EUR', symbolBefore: false, decimal: ',' },
];

// Verified present on all six domains via each site's sitemap_master_product_pages.xml.
const MODELS = [
  { slug: 'playstation-5',      name: 'PlayStation 5' },
  { slug: 'playstation-5-slim', name: 'PlayStation 5 Slim' },
  { slug: 'playstation-5-pro',  name: 'PlayStation 5 Pro' },
];

// Back Market's own numeric grade ids, read straight off the radio inputs.
// Lower rank = better condition. Names are ours, so six locales render identically.
export const GRADES = {
  '9':  { grade: 'premium',   rank: 0, label: 'Premium' },
  '10': { grade: 'excellent', rank: 1, label: 'Excellent' },
  '11': { grade: 'very_good', rank: 2, label: 'Very good' },
  '12': { grade: 'good',      rank: 3, label: 'Good' },
  '13': { grade: 'fair',      rank: 4, label: 'Fair' },
};
const gradeOf = id => GRADES[String(id)]
  || { grade: `unknown_${id}`, rank: 9, label: `Unknown (id ${id})` };

const DATA_FILE = join(HERE, 'data.json');
const SEEN_FILE = join(HERE, 'seen.json');

const argv = process.argv.slice(2);
const argOf = n => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : null; };
const PROBE = argOf('--probe');                 // e.g. de/playstation-5
const LIMIT = Number(argOf('--limit') || 0);
const NO_NOTIFY = argv.includes('--no-notify');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const DEBUG = !!process.env.PS5_DEBUG;
const readJson = (f, fallback) => {
  try { return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : fallback; }
  catch { return fallback; }
};

// ─────────────────────────────────────────────────────────────────────────────
// Price parsing — the highest-risk piece, so it is exported and unit-tested.
//
// Two real formats, both confirmed live:
//   DE/FR/IT/BE/NL  "599,00 €"   symbol after, comma decimal, dot thousands
//   UK              "£469.99"    symbol before, dot decimal, comma thousands
// A single naive regex silently returns null or a 100x-wrong number.
// ─────────────────────────────────────────────────────────────────────────────

export function parsePrice(text, market) {
  if (!text) return null;
  const m = market.symbolBefore
    ? String(text).match(/[£€]\s*([\d.,]+)/)
    : String(text).match(/([\d.,]+)\s*[£€]/);
  if (!m) return null;
  let n = m[1];
  if (market.decimal === ',') n = n.replace(/\./g, '').replace(',', '.');
  else n = n.replace(/,/g, '');
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  if (v < CONFIG.minPlausible || v > CONFIG.maxPlausible) return null;
  return v;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chrome driver over CDP. Lifted from ../odyssey-watch/scrape.mjs:66-116.
// ─────────────────────────────────────────────────────────────────────────────

async function chrome(lang) {
  // A fresh throwaway profile per market. Reusing one to keep the clearance cookie
  // sounds attractive, but we SIGKILL Chrome at the end of each market, which leaves
  // a stale SingletonLock behind — the next launch then hangs on it indefinitely.
  // The dwell in gotoAndSettle clears the challenge in ~9s anyway, so this is cheap.
  const dir = mkdtempSync(join(tmpdir(), 'ps5-'));
  // Pick the debug port ourselves and launch Chrome with stdio fully ignored.
  //
  // This is empirical, not theoretical: with --remote-debugging-port=0 and stderr
  // piped (so the port could be read back from it), every product page parked on
  // /testchallengepage indefinitely. With a fixed port and stdio 'ignore' — the only
  // difference — pages clear on the first try. Bisected against a working prototype.
  // If you change this line, re-run `node scrape.mjs --probe de/playstation-5`.
  const port = 9200 + Math.floor(Math.random() * 700);
  const proc = spawn(CHROME, [...EXTRA_FLAGS, '--headless=new', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`,
    '--window-size=1400,1000', `--lang=${lang}`, `--user-agent=${UA}`,
    ], { stdio: 'ignore' });

  // Attach to the tab Chrome opened for itself, rather than Target.createTarget-ing a
  // new one. This matters: in a CDP-created target the Cloudflare challenge never
  // completes (observed: 30s stuck on "Just a moment…" on every product page), while
  // the browser's own initial tab clears it in ~2.5s.
  let page = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      page = list.find(t => t.type === 'page');
      if (page) break;
    } catch {}
    await sleep(250);
  }
  if (!page) { proc.kill('SIGKILL'); throw new Error('no page target'); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise(res => {
    const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params }));
  });
  await send('Page.enable');

  const evalJs = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r?.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text || 'js error');
    return r?.result?.result?.value;
  };
  // Park on about:blank between products, so the NEXT navigation can't be read while the
  // PREVIOUS product page is still up — that silently attributes one console's price to
  // another. See odyssey-watch/scrape.mjs:97-103 for the original bite.
  const reset = async () => {
    await send('Page.navigate', { url: 'about:blank' });
    const t0 = Date.now();
    while (Date.now() - t0 < 10000) {
      if (/about:blank/.test(await evalJs('location.href') || '')) return true;
      await sleep(200);
    }
    return false;
  };
  // Back Market bounces an unvetted browser to /testchallengepage?next=<target>.
  //
  // The crucial, counter-intuitive part: that challenge page does NOT redirect onward
  // by itself — it will sit there indefinitely (observed: 60s, no change). What clears
  // it is DWELLING on it for a few seconds, which earns the clearance cookie, and then
  // navigating to the target AGAIN. So this is navigate → dwell → re-navigate, not
  // navigate → wait-until-cleared. Waiting for a redirect that never comes was exactly
  // the bug that made every product page fail.
  const gotoAndSettle = async (url, tries = 3, dwell = CONFIG.dwellMs) => {
    for (let i = 1; i <= tries; i++) {
      await send('Page.navigate', { url });
      await sleep(dwell);
      const title = await evalJs('document.title') || '';
      const href  = await evalJs('location.href') || '';
      const len   = await evalJs('(document.body && document.body.innerText || "").length') || 0;
      if (DEBUG) console.log(`    try ${i}/${tries} title=${JSON.stringify(title)} len=${len} url=${href.slice(0, 90)}`);
      const blocked = /testchallengepage/.test(href) || /just a moment|attention required/i.test(title);
      if (!blocked && len > 600) { await sleep(800); return true; }
    }
    return false;
  };
  // One dwell per market before the first product page, so that page isn't spent on
  // the challenge. Same mechanism as above; we don't care what it renders.
  const warmup = async url => { await send('Page.navigate', { url }); await sleep(CONFIG.dwellMs); };
  return {
    evalJs, reset, gotoAndSettle, warmup,
    close: () => { try { ws.close(); } catch {} proc.kill('SIGKILL'); },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Extraction — one round trip per page, returns raw strings for Node to parse.
// ─────────────────────────────────────────────────────────────────────────────

const EXTRACT_JS = `(() => {
  const jsonld = [...document.querySelectorAll('script[type="application/ld+json"]')]
    .map(s => { try { return JSON.parse(s.textContent); } catch { return null; } })
    .filter(Boolean)
    .find(o => o && o['@type'] === 'Product') || null;
  const opts = name => [...document.querySelectorAll('input[name="' + name + '"]')].map(r => ({
    id: r.value,
    checked: !!r.checked,
    label: ((r.closest('label') || r.parentElement || {}).innerText || '').replace(/\\s+/g, ' ').trim(),
  }));
  const priceEl = document.querySelector('[data-qa="productpage-product-price"]');
  return JSON.stringify({
    title: document.title,
    h1: (document.querySelector('h1') || {}).innerText || '',
    jsonld,
    grades: opts('step-grades'),
    storages: opts('step-storage'),
    headline: priceEl ? priceEl.innerText.trim() : '',
    body: (document.body.innerText || '').slice(0, 6000),
  });
})()`;

// Seller name is a nice-to-have and is phrased differently per locale, so we take a
// best effort and accept null rather than inventing a fragile six-language regex.
function sellerFrom(body) {
  const pats = [
    /(?:Professionell erneuert von|Reconditionn[ée] par|Ricondizionato da|Gereviseerd door|Refurbished by)\s+([^\n]{2,60})/i,
  ];
  for (const p of pats) { const m = body.match(p); if (m) return m[1].trim(); }
  return null;
}

async function scrapeProduct(br, market, model, { reset = true } = {}) {
  const url = `https://${market.host}/${market.locale}/p/${model.slug}`;
  if (reset) await br.reset();
  if (!await br.gotoAndSettle(url)) throw new Error('page never cleared the challenge');

  const raw = JSON.parse(await br.evalJs(EXTRACT_JS));

  // Identity gate: refuse to trust a page that isn't the product we asked for.
  // ../odyssey-watch/scrape.mjs:147-152 — same idea, different site.
  const hay = `${raw.title} ${raw.h1} ${raw.jsonld?.name || ''}`.toLowerCase();
  const wantSlim = model.slug.endsWith('slim'), wantPro = model.slug.endsWith('pro');
  if (!/playstation\s*5|ps5/.test(hay)) throw new Error(`identity gate: not a PS5 page (title="${raw.title}")`);
  if (wantSlim && !/slim/.test(hay)) throw new Error('identity gate: expected Slim');
  if (wantPro  && !/\bpro\b/.test(hay)) throw new Error('identity gate: expected Pro');
  if (!wantSlim && !wantPro && /slim|\bpro\b/.test(hay)) throw new Error('identity gate: got a variant page');

  // A model with NO offers at all in this market renders with no grade picker AND no
  // Product JSON-LD — that is how Back Market draws a fully sold-out product page
  // (verified on /p/playstation-5-pro, which is out of stock in all six markets).
  // That is a real answer, not a scraping failure, so don't report it as an error.
  // If the grades vanish but the JSON-LD is still there, the selector genuinely broke.
  if (!raw.grades.length) {
    if (raw.jsonld) throw new Error('no grade options found — selector likely changed');
    return { offers: [], soldOutModel: true };
  }

  const ld = raw.jsonld || {};
  const storage = ld.storage
    || (raw.storages.find(s => s.checked)?.label || '').split(/\s{2,}|\n/)[0]?.trim()
    || null;
  const seller = sellerFrom(raw.body);
  const now = new Date().toISOString();

  const offers = raw.grades.map(g => {
    const meta = gradeOf(g.id);
    const price = parsePrice(g.label, market);   // no price parses => that grade is sold out
    return {
      key: `${market.key}|${model.slug}|${storage || '?'}|${meta.grade}`,
      market: market.key, country: market.country,
      model: model.name, slug: model.slug,
      productId: ld.productID || null,
      storage, color: ld.color || null,
      gradeId: g.id, grade: meta.grade, gradeRank: meta.rank, gradeLabel: meta.label,
      gradeLabelRaw: g.label,
      price, currency: market.currency,
      priceEur: price == null ? null
        : Math.round((market.currency === 'GBP' ? price * CONFIG.gbpToEur : price) * 100) / 100,
      available: price != null,
      seller, url,
      firstSeen: now, lastSeen: now,
    };
  });

  return { offers, soldOutModel: false };
}

// ─────────────────────────────────────────────────────────────────────────────

export function shouldAlert(o) {
  if (!o.available || o.gradeRank > CONFIG.maxGradeRank) return false;
  const cap = o.currency === 'GBP' ? CONFIG.maxPriceGbp : CONFIG.maxPriceEur;
  return o.price <= cap;
}

async function main() {
  const prev = readJson(DATA_FILE, { offers: [] });
  const prevByKey = new Map((prev.offers || []).map(o => [o.key, o]));
  const seen = readJson(SEEN_FILE, { alerts: [] });
  const seenSet = new Set((seen.alerts || []).map(a => a.id));

  let targets = [];
  for (const m of MARKETS) for (const mo of MODELS) targets.push({ market: m, model: mo });
  if (PROBE) {
    const [mk, sl] = PROBE.split('/');
    targets = targets.filter(t => t.market.key === mk && (!sl || t.model.slug === sl));
    if (!targets.length) { console.error(`--probe ${PROBE} matched nothing`); process.exit(1); }
  }
  if (LIMIT) targets = targets.slice(0, LIMIT);

  const offers = []; const errors = []; const unavailable = []; let pages = 0;

  // Group by market so each domain gets exactly one warm-up navigation.
  const byMarket = new Map();
  for (const t of targets) {
    if (!byMarket.has(t.market.key)) byMarket.set(t.market.key, { market: t.market, models: [] });
    byMarket.get(t.market.key).models.push(t.model);
  }

  for (const { market, models } of byMarket.values()) {
    const br = await chrome(market.lang);
    try {
      // Warm-up. This navigation is EXPECTED to sit on the Cloudflare challenge —
      // its job is to acquire the clearance cookie, not to render. Product pages
      // load clean immediately afterwards.
      process.stdout.write(`\n[${market.key}] warm-up… `);
      await br.warmup(`https://${market.host}/${market.locale}`);
      console.log('done');

      let first = true;
      for (const model of models) {
        pages++;
        try {
          const useReset = !first; first = false;
          const { offers: got, soldOutModel } = await scrapeProduct(br, market, model, { reset: useReset });
          if (soldOutModel) {
            unavailable.push({ market: market.key, country: market.country, model: model.name, slug: model.slug });
            console.log(`  ${market.key}/${model.slug}: no offers at all (model sold out)`);
          } else {
            offers.push(...got);
            const live = got.filter(o => o.available);
            console.log(`  ${market.key}/${model.slug}: ${got.length} grades, ${live.length} in stock` +
              (live.length ? ` — cheapest ${live.reduce((a, b) => a.price < b.price ? a : b).price} ${market.currency}` : ''));
          }
        } catch (e) {
          errors.push(`${market.key}/${model.slug}: ${e.message}`);
          console.log(`  ${market.key}/${model.slug}: FAILED — ${e.message}`);
        }
        await sleep(CONFIG.pageDelayMs);
      }
    } finally { br.close(); }
  }

  // Carry first-seen forward so the dashboard can show how long a price has held.
  for (const o of offers) {
    const p = prevByKey.get(o.key);
    if (p && p.available === o.available && p.price === o.price && p.firstSeen) o.firstSeen = p.firstSeen;
  }

  // "Everything is sold out" and "the scraper is broken" look identical, so prove
  // the happy path: a real run must find at least one priced offer somewhere.
  const verified = offers.some(o => o.available) && errors.length < pages;

  if (PROBE) {
    console.log('\n--- probe result (data.json NOT written) ---');
    console.log(JSON.stringify(offers, null, 2));
    if (unavailable.length) console.log('models with no offers at all:', JSON.stringify(unavailable));
    console.log(`\nverified=${verified} errors=${errors.length}`);
    // A probe that found nothing is a FAILING probe. Without this the CI self-test
    // reports success even when every page was blocked, which defeats its purpose.
    if (!verified) process.exitCode = 1;
    return;
  }

  const fresh = offers.filter(o => shouldAlert(o) && !seenSet.has(`${o.key}@${o.price}`));

  const out = {
    updated: new Date().toISOString(),
    verified,
    config: { maxPriceEur: CONFIG.maxPriceEur, maxPriceGbp: CONFIG.maxPriceGbp, gbpToEur: CONFIG.gbpToEur },
    counts: { pages, ok: pages - errors.length, errors: errors.length, offers: offers.length,
              inStock: offers.filter(o => o.available).length,
              modelsWithNoOffers: unavailable.length, alerted: fresh.length },
    errors, unavailable,
    offers: offers.sort((a, b) => (a.priceEur ?? 1e9) - (b.priceEur ?? 1e9)),
  };
  writeFileSync(DATA_FILE, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nWrote data.json — ${out.counts.inStock}/${out.counts.offers} in stock, ` +
              `${errors.length} error(s), verified=${verified}`);

  if (fresh.length && !NO_NOTIFY) {
    const sent = await notifyAll(fresh);
    console.log(`Telegram: ${sent}/${fresh.length} alert(s) sent`);
  } else if (!fresh.length) {
    console.log('No new offers under the alert threshold.');
  }

  // Remember what we alerted so a re-run doesn't re-notify. Keep 30 days.
  if (fresh.length) {
    const cutoff = Date.now() - 30 * 864e5;
    const kept = (seen.alerts || []).filter(a => new Date(a.at).getTime() > cutoff);
    for (const o of fresh) kept.push({ id: `${o.key}@${o.price}`, at: out.updated });
    writeFileSync(SEEN_FILE, JSON.stringify({ alerts: kept }, null, 2) + '\n');
  }

  if (!verified) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
