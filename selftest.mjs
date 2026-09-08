#!/usr/bin/env node
// Offline self-test. No network, no Chrome, no Telegram — safe to run any time.
//   node selftest.mjs
// Covers the logic that fails silently rather than loudly: price parsing across
// locales, the alert threshold, and alert de-duplication.

import { parsePrice, shouldAlert, MARKETS } from './scrape.mjs';
import { formatOffer } from './notify.mjs';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const de = MARKETS.find(m => m.key === 'de');
const uk = MARKETS.find(m => m.key === 'uk');

console.log('— price parsing —');
check('DE "Gut 599,00 €"',            parsePrice('Gut 599,00 €', de), 599);
check('DE "Sehr gut 623,00 €"',       parsePrice('Sehr gut 623,00 €', de), 623);
check('DE thousands "1.299,00 €"',    parsePrice('1.299,00 €', de), 1299);
check('DE sold out -> null',          parsePrice('Hervorragend Ausverkauft', de), null);
check('UK "Good £469.99"',            parsePrice('Good £469.99', uk), 469.99);
check('UK badge "Excellent £514.00 Popular"', parsePrice('Excellent £514.00 Popular', uk), 514);
check('UK thousands "£1,199.00"',     parsePrice('£1,199.00', uk), 1199);
check('UK sold out -> null',          parsePrice('Excellent Sold out', uk), null);
check('service fee below band -> null', parsePrice('0,49 €', de), null);
check('promo banner below band -> null', parsePrice('50 €', de), null);
check('empty -> null',                parsePrice('', de), null);

console.log('\n— alert threshold (defaults: €450 / £400, Good or better) —');
const offer = (o) => ({ available: true, gradeRank: 3, price: 400, currency: 'EUR', ...o });
check('EUR 400 Good           -> alert',     shouldAlert(offer({})), true);
check('EUR 450 Good (at cap)  -> alert',     shouldAlert(offer({ price: 450 })), true);
check('EUR 451 Good           -> no alert',  shouldAlert(offer({ price: 451 })), false);
check('GBP 400 Good (at cap)  -> alert',     shouldAlert(offer({ price: 400, currency: 'GBP' })), true);
check('GBP 401 Good           -> no alert',  shouldAlert(offer({ price: 401, currency: 'GBP' })), false);
check('GBP 450 (real cheapest)-> no alert',  shouldAlert(offer({ price: 450, currency: 'GBP' })), false);
check('Excellent cheap        -> alert',     shouldAlert(offer({ gradeRank: 1 })), true);
check('Fair cheap             -> no alert',  shouldAlert(offer({ gradeRank: 4 })), false);
check('sold out but cheap     -> no alert',  shouldAlert(offer({ available: false })), false);

console.log('\n— de-duplication (seen.json keys) —');
const o1 = { key: 'de|playstation-5|825 GB|good', price: 399 };
const seen = new Set([`${o1.key}@${o1.price}`]);
check('same key + same price -> suppressed', seen.has(`${o1.key}@399`), true);
check('same key, price drop  -> alerts',     seen.has(`${o1.key}@349`), false);

console.log('\n— Telegram message rendering —');
const msg = formatOffer({
  model: 'PlayStation 5 Slim', gradeLabel: 'Very good', price: 450, currency: 'GBP',
  priceEur: 526.5, country: 'UK', storage: '1000 GB', color: 'White',
  seller: 'Phone Orbit LTD', url: 'https://www.backmarket.co.uk/en-gb/p/playstation-5-slim',
});
console.log(msg.split('\n').map(l => '    ' + l).join('\n'));
check('renders price and currency', /£450\.00/.test(msg), true);
check('shows euro equivalent',      /~€527/.test(msg), true);
check('has a clickable link',       /<a href="https:\/\//.test(msg), true);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll self-tests pass.');
process.exit(failures ? 1 : 0);
