#!/usr/bin/env node
//
// morpheus.mjs — drive self-dev from outside the browser.
//
// WHY THIS EXISTS
//
// Every step of self-dev's post-push chain lives in SelfDev.jsx, and every
// self-dev function requires an admin JWT. So the pipeline could only ever be
// run — and, worse, only ever be *observed* — by a human in a logged-in tab.
// That is why a 3-in-17 revert rate, a smoke check that has never once fired
// and three capabilities that have never executed all went unnoticed. This CLI
// plus the operator token (server/src/lib/operatorToken.js) is the smallest
// thing that lets a non-browser client run a real dogfood cycle and read back
// what happened.
//
// WHAT IT DELIBERATELY CANNOT DO
//
// It cannot push to main, skip the verify gate, override the drift guard, or
// call anything outside OPERATOR_SCOPE_FUNCTIONS — see operatorToken.js. This
// client does not send `force`, `directToMain` or `acknowledgeDrift` at all,
// and the server strips them even if it did.
//
// USAGE
//
//   node scripts/morpheus.mjs whoami
//   node scripts/morpheus.mjs sync
//   node scripts/morpheus.mjs chat "add a card to the proving ground page"
//   node scripts/morpheus.mjs verify
//   node scripts/morpheus.mjs push
//   node scripts/morpheus.mjs merge 191
//   node scripts/morpheus.mjs smoke
//
// Credentials come from server/.env.morpheusops (gitignored):
//
//   MORPHEUS_API_BASE=https://api.morpheus.nz/api
//   MORPHEUS_OPERATOR_TOKEN=opr_...
//
// The token is never printed, never passed as an argument (it would land in a
// shell history and in any transcript that quotes the command), and never
// logged on failure. Only its fingerprint is ever shown, so a run can be
// correlated without the value existing anywhere but that one file.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { operatorTokenFingerprint, OPERATOR_TOKEN_PREFIX } from '../server/src/lib/operatorToken.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const ENV_FILE = process.env.MORPHEUS_OPS_ENV || path.join(REPO, 'server', '.env.morpheusops');

const DEFAULT_BASE = 'https://api.morpheus.nz/api';
// A chat turn is a whole plan → code → review → verify cycle and can genuinely
// take fifteen minutes; a push is dominated by the GitHub round trip. Both are
// wall-clock caps on how long THIS client waits, not server-side deadlines.
const TIMEOUT_MS = { default: 5 * 60 * 1000, chat: 25 * 60 * 1000 };

function readOpsEnv() {
  const out = {};
  if (!existsSync(ENV_FILE)) return out;
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const ops = readOpsEnv();
const BASE = String(ops.MORPHEUS_API_BASE || process.env.MORPHEUS_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
const TOKEN = ops.MORPHEUS_OPERATOR_TOKEN || process.env.MORPHEUS_OPERATOR_TOKEN || '';

function fail(message, code = 1) {
  console.error(`✗ ${message}`);
  process.exit(code);
}

if (!TOKEN) {
  fail(`No operator token. Put MORPHEUS_OPERATOR_TOKEN in ${ENV_FILE} (see server/.env.example).`, 2);
}
if (!TOKEN.startsWith(OPERATOR_TOKEN_PREFIX)) {
  fail(`The configured token is not an operator token (expected the ${OPERATOR_TOKEN_PREFIX} prefix).`, 2);
}

/** Every request goes through here — one place that attaches the credential. */
async function call(name, body = {}, { stream = false, timeoutMs = TIMEOUT_MS.default } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/functions/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!stream) {
      const text = await res.text();
      let parsed;
      try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text.slice(0, 2000) }; }
      return { ok: res.ok, status: res.status, body: parsed };
    }
    return { ok: res.ok, status: res.status, stream: res.body };
  } catch (err) {
    if (err.name === 'AbortError') fail(`${name} did not finish within ${Math.round(timeoutMs / 1000)}s — it may still be running server-side.`);
    fail(`${name} failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

function report(name, result) {
  if (result.ok) {
    console.log(`✓ ${name}`);
    console.log(JSON.stringify(result.body, null, 2));
    return true;
  }
  console.error(`✗ ${name} → HTTP ${result.status}`);
  console.error(JSON.stringify(result.body, null, 2));
  process.exitCode = 1;
  return false;
}

/** Consume chatWithMorpheus's NDJSON progress stream line by line. */
async function streamChat(stream) {
  const decoder = new TextDecoder();
  let buffer = '';
  let reply = null;
  let failure = null;
  const started = Date.now();

  const elapsed = () => `${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s`;

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'stage') {
        if (event.status === 'start') console.log(`${elapsed()}  ▸ ${event.stage}${event.label ? ` — ${event.label}` : ''}${event.etaSeconds ? ` (~${event.etaSeconds}s)` : ''}`);
        else if (event.status === 'done') console.log(`${elapsed()}  ✓ ${event.stage}${event.seconds !== undefined ? ` (${event.seconds}s)` : ''}`);
        else if (event.status === 'failed') console.log(`${elapsed()}  ✗ ${event.stage}${event.error ? ` — ${event.error}` : ''}`);
      } else if (event.type === 'result') {
        reply = event.data || {};
      } else if (event.type === 'error') {
        failure = event;
      }
    }
  }

  if (failure) {
    console.error(`\n✗ turn failed: ${failure.message}`);
    if (failure.code) console.error(`  code: ${failure.code}`);
    process.exitCode = 1;
    return;
  }
  if (!reply) {
    console.error('\n✗ the stream ended without a result — the turn did not finish.');
    process.exitCode = 1;
    return;
  }
  const files = reply.fileOperations || [];
  console.log(`\n${reply.reply || '(no reply text)'}`);
  if (files.length) {
    console.log(`\nfiles touched (${files.length}):`);
    for (const f of files) console.log(`  ${f.action || 'update'}  ${f.path}`);
  }
  console.log(`\nnot pushed yet — review the change, then: node scripts/morpheus.mjs push`);
}

const [command, ...args] = process.argv.slice(2);

console.log(`morpheus operator ${operatorTokenFingerprint(TOKEN)} → ${BASE}`);

switch (command) {
  case 'whoami': {
    // The cheapest read-only self-dev call there is: proves the token, the
    // allow-list and the self-dev workspace in one round trip.
    report('getSelfDevFeatures', await call('getSelfDevFeatures'));
    break;
  }

  case 'sync': {
    const r = await call('importSelfDevRepo', {}, { timeoutMs: 10 * 60 * 1000 });
    report('importSelfDevRepo (sync from GitHub)', r);
    break;
  }

  case 'verify': {
    report('verifySelfDev', await call('verifySelfDev'));
    break;
  }

  case 'push': {
    // No force, no directToMain, no acknowledgeDrift — by construction. The
    // server strips them anyway; this client simply never offers them.
    const r = await call('pushSelfDevToGithub', {}, { timeoutMs: 10 * 60 * 1000 });
    if (report('pushSelfDevToGithub', r)) {
      const b = r.body || {};
      if (b.blocked) console.error(`\nPush was blocked: ${b.blockReason || 'see the response above'}`);
      else if (b.prNumber) console.log(`\nPR #${b.prNumber}${b.prUrl ? ` → ${b.prUrl}` : ''}\nnext: node scripts/morpheus.mjs merge ${b.prNumber}`);
      else if (b.mode === 'direct') fail('The server pushed directly to the main branch — the operator token must not be able to do that. Investigate before trusting this path.');
      if (b.blocked) process.exitCode = 1;
    }
    break;
  }

  case 'merge': {
    const prNumber = Number(args[0]);
    if (!Number.isInteger(prNumber) || prNumber <= 0) fail('usage: node scripts/morpheus.mjs merge <prNumber>', 2);
    // No force: this merges only when the required checks have run and passed.
    const r = await call('mergeSelfDevPr', { prNumber }, { timeoutMs: 10 * 60 * 1000 });
    if (report(`mergeSelfDevPr #${prNumber}`, r)) {
      const b = r.body || {};
      if (b.merged === false && b.state) console.error(`\nNot merged: ${b.state}${b.message ? ` — ${b.message}` : ''}`);
    }
    break;
  }

  case 'smoke': {
    report('smokeCheckSelfDev', await call('smokeCheckSelfDev'));
    break;
  }

  case 'chat': {
    const message = args.join(' ').trim();
    if (!message) fail('usage: node scripts/morpheus.mjs chat "<what to change>"', 2);
    const result = await call('chatWithMorpheus', { message, mode: 'build' }, { stream: true, timeoutMs: TIMEOUT_MS.chat });
    if (!result.ok) {
      console.error(`✗ chatWithMorpheus → HTTP ${result.status}`);
      process.exitCode = 1;
      break;
    }
    await streamChat(result.stream);
    break;
  }

  default:
    console.log(`
commands:
  whoami                    confirm the token and show the self-dev features
  sync                      pull main into the self-dev workspace
  chat "<request>"          run one build turn against the workspace (streams)
  verify                    run the in-product verify gate
  push                      push the workspace as a PR (never direct to main)
  merge <prNumber>          merge once the required checks have passed
  smoke                     post-deploy health probes
`);
    if (command && command !== 'help' && command !== '--help') process.exitCode = 2;
}
