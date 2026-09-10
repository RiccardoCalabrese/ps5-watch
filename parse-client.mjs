#!/usr/bin/env node
// Thin client for Parse (https://parse.bot) — turns Back Market into a JSON API.
//
// Why this is Node and not the Python SDK: calling a built Parse API is one HTTP
// POST with one header, and ps5-watch is deliberately dependency-free. The uv/
// parse-sdk setup in this directory is for exploring the typed schema during
// development; this file is what the scraper actually uses.
//
// The key is read from the environment (or the gitignored .env) — never hard-coded.

try { process.loadEnvFile(new URL('.env', import.meta.url)); } catch { /* no .env, fine */ }

const BASE = 'https://api.parse.bot';
const key = () => {
  const k = process.env.PARSE_API_KEY || '';
  if (!k) throw new Error('PARSE_API_KEY is not set — add it to .env (see .env.example)');
  return k;
};

async function req(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'X-API-Key': key(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (!res.ok) throw new Error(`Parse ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return json ?? text;
}

/** Progress of a build task, e.g. the backmarket.co.uk API being built. */
export const taskStatus = id => req(`/dispatch/tasks/${id}`);

/** Call a built endpoint. Params go in the JSON body for POST endpoints. */
export const callEndpoint = (scraperId, endpoint, params = {}) =>
  req(`/scraper/${scraperId}/${endpoint}`, { method: 'POST', body: params });

// TODO(parse): fill these in once build task 9e14f6fd-c5ee-4aa2-8773-9bbe92b2a483
// finishes. The scraper id and endpoint names are on its dashboard page:
// https://parse.bot/tasks/9e14f6fd-c5ee-4aa2-8773-9bbe92b2a483
export const BACKMARKET = {
  scraperId: null,   // TODO
  endpoint: null,    // TODO — e.g. 'search'
};

// CLI: `node parse-client.mjs task <id>` or `node parse-client.mjs call <scraperId> <endpoint>`
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === 'task') console.log(JSON.stringify(await taskStatus(a), null, 2));
    else if (cmd === 'call') console.log(JSON.stringify(await callEndpoint(a, b, {}), null, 2));
    else console.log('usage: node parse-client.mjs task <taskId> | call <scraperId> <endpoint>');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
