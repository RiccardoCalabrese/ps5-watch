#!/usr/bin/env node
// Telegram push for ps5-watch. Zero dependencies: one fetch to the Bot API.
//
// Credentials come from the environment, never from a file in the repo:
//   TELEGRAM_BOT_TOKEN  from @BotFather
//   TELEGRAM_CHAT_ID    your own chat id (see README)
//
// Silence is deliberate when the tokens are absent: a local `node scrape.mjs`
// on the Mac should scrape and write data.json without needing secrets set up.

// Load .env if present, so the scheduled job doesn't depend on a shell profile.
// .env is gitignored and never committed. Environment variables already set win,
// which is what lets CI (or a one-off command) override the file.
try { process.loadEnvFile(new URL('.env', import.meta.url)); } catch { /* no .env, fine */ }

const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT  = () => process.env.TELEGRAM_CHAT_ID   || '';

export const canNotify = () => Boolean(TOKEN() && CHAT());

const esc = s => String(s).replace(/[<>&]/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;' }[c]));

// One offer -> one message. Kept short so it reads fully in a phone notification.
export function formatOffer(o) {
  const price = `${o.currency === 'GBP' ? '£' : '€'}${o.price.toFixed(2)}`;
  const cmp = o.currency === 'GBP' ? ` (~€${o.priceEur.toFixed(0)})` : '';
  return [
    `🎮 <b>${esc(o.model)}</b> — ${esc(o.gradeLabel)}`,
    `<b>${price}</b>${cmp} · ${esc(o.country)}`,
    o.storage ? `${esc(o.storage)}${o.color ? ' · ' + esc(o.color) : ''}` : '',
    o.seller ? `Seller: ${esc(o.seller)}` : '',
    `<a href="${esc(o.url)}">Open on Back Market →</a>`,
  ].filter(Boolean).join('\n');
}

async function send(text) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN()}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT(), text, parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    }),
  });
  if (!res.ok) throw new Error(`telegram ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}

// Never let a notification failure lose a good scrape: report and carry on.
export async function notifyAll(offers) {
  if (!offers.length) return 0;
  if (!canNotify()) {
    console.log(`(${offers.length} alert(s) suppressed — TELEGRAM_BOT_TOKEN/CHAT_ID not set)`);
    return 0;
  }
  let sent = 0;
  for (const o of offers) {
    try { await send(formatOffer(o)); sent++; }
    catch (e) { console.error(`notify failed for ${o.key}: ${e.message}`); }
    await new Promise(r => setTimeout(r, 400));   // Telegram rate limit
  }
  return sent;
}

// `node notify.mjs "hello"` — used by the README to confirm setup works.
if (import.meta.url === `file://${process.argv[1]}`) {
  const msg = process.argv[2] || '✅ ps5-watch: Telegram is wired up correctly.';
  if (!canNotify()) { console.error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID first.'); process.exit(1); }
  await send(msg); console.log('Sent.');
}
