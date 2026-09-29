// Reach your Portable Morpheus from anywhere — through your own tailnet, not the open internet.
//
//   node scripts/portable-remote.mjs            # what is the state, and what would change
//   node scripts/portable-remote.mjs --enable   # expose the local server to your tailnet
//   node scripts/portable-remote.mjs --disable  # stop exposing it
//
// Decided 2026-09-29 (Rob): Tailscale. The reasoning, and why not a Cloudflare tunnel or a public port,
// is in MORPHEUS-BIG-PICTURE.md → Portable Morpheus and restated in server/src/lib/portableRemote.js.
//
// Two things this will NOT do, both deliberate: it will not install Tailscale (system-level, needs admin
// and an account sign-in), and it will not guess `tailscale serve`'s syntax — that has changed across
// versions, so the installed CLI is asked to do the work and its own error is printed if it disagrees.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_ENV } from '../server/src/lib/portableSetup.js';
import {
  REMOTE_STEPS, REMOTE_CAVEATS, tailscaleInstallHint, remoteUrlFromStatus, tailscaleReady,
  serveCommands, backendPublicUrlLine,
} from '../server/src/lib/portableRemote.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, 'server', '.env');
const PORT = Number(LOCAL_ENV.PORT);

const argv = process.argv.slice(2);
const ENABLE = argv.includes('--enable');
const DISABLE = argv.includes('--disable');
const say = (s) => console.log(s);

/** Run a command and hand back {ok, out, err} — never throwing, because the CLI's message IS the answer. */
function tryRun(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), status: r.status };
}

function tailscaleBin() {
  const which = tryRun(process.platform === 'win32' ? 'where' : 'which', ['tailscale']);
  return which.ok && which.out ? which.out.split('\n')[0].trim() : null;
}

/** The .env line is edited in place; everything else in the file is left exactly as it was. */
function setEnvLine(line) {
  if (!existsSync(ENV_PATH)) {
    say(`  ✗ server/.env is missing — run the setup first: npm run portable:setup`);
    process.exit(1);
  }
  const text = readFileSync(ENV_PATH, 'utf8');
  const key = line.split('=')[0];
  const kept = text.split('\n').filter((l) => !l.startsWith(`${key}=`));
  writeFileSync(ENV_PATH, `${[...kept, line].join('\n').replace(/\n+$/, '')}\n`);
  say(`  · server/.env: ${line.includes('=') && line.split('=')[1] ? `${key} set` : `${key} cleared`}`);
}

const bin = tailscaleBin();
say('\n  PORTABLE MORPHEUS — remote access (Tailscale)');

if (!bin) {
  // The honest path for the common case: this is the operator's step, and we say exactly what it is.
  say('\n  Tailscale is not installed on this machine.\n');
  const hint = tailscaleInstallHint(process.platform);
  if (hint) {
    say('  Install it (this is yours to do — we do not install system software for you):');
    say(`    ${hint.command}`);
    say(`    ${hint.also}`);
    say(`\n  ${hint.note}`);
  } else {
    say('  See https://tailscale.com/download for this platform.');
  }
  say('\n  Then run: npm run portable:remote -- --enable');
  say('\n  What enabling will do:');
  REMOTE_STEPS.forEach((s, i) => say(`    ${i + 1}. ${s.title}`));
  say('');
  for (const c of REMOTE_CAVEATS) say(`  · ${c}`);
  say('');
  process.exit(ENABLE ? 2 : 0);
}

say(`  tailscale: ${bin}`);
const cmds = serveCommands(PORT);
const status = tryRun(bin, cmds.status.slice(1));
let parsed = null;
try { parsed = JSON.parse(status.out); } catch { /* older CLI or signed out — handled below */ }
const url = remoteUrlFromStatus(parsed);

// ── read-only: where things stand ───────────────────────────────────────────
say(`  local server: http://localhost:${PORT}`);
const current = tryRun(bin, cmds.serveStatus.slice(1));
if (current.ok && current.out) {
  say('\n  Currently serving:');
  for (const l of current.out.split('\n')) say(`    ${l}`);
} else {
  say('  Currently serving: nothing');
}
say(`  tailnet URL: ${url || '(not reported — is Tailscale signed in?)'}`);

if (!ENABLE && !DISABLE) {
  say('\n  What --enable will do:');
  REMOTE_STEPS.forEach((s, i) => say(`    ${i + 1}. ${s.title}`));
  say(`\n  It runs:  ${cmds.enable.join(' ')}`);
  say(`  And sets: ${backendPublicUrlLine(url || '<tailnet URL>')}`);
  say('');
  for (const c of REMOTE_CAVEATS) say(`  · ${c}`);
  say('');
  process.exit(0);
}

// ── mutating paths, all after the checks above ──────────────────────────────
const ready = tailscaleReady(parsed);
if (ENABLE && !ready.ok) {
  say(`\n  ✗ ${ready.reason}`);
  say('    Nothing was changed.\n');
  process.exit(2);
}

if (DISABLE) {
  const r = tryRun(bin, cmds.disable.slice(1));
  if (!r.ok) {
    say(`\n  ✗ "${cmds.disable.join(' ')}" failed: ${r.err || r.out}`);
    say(`    Your CLI may use different syntax — see: ${cmds.help.join(' ')}\n`);
    process.exit(1);
  }
  say('  · tailscale serve reset — the app is no longer exposed to your tailnet');
  setEnvLine(backendPublicUrlLine(''));
  say('\n  Done. Local access is unaffected.\n');
  process.exit(0);
}

const r = tryRun(bin, cmds.enable.slice(1));
if (!r.ok) {
  // Show the CLI's own words. Guessing an older syntax here is how a script ends up doing something
  // other than what it says it did.
  say(`\n  ✗ "${cmds.enable.join(' ')}" failed.`);
  say(`    tailscale said: ${r.err || r.out || `(exit ${r.status}, no output)`}`);
  say(`\n    This may be a version whose syntax differs. See what yours supports: ${cmds.help.join(' ')}`);
  say('    Nothing else was changed.\n');
  process.exit(1);
}

setEnvLine(backendPublicUrlLine(url));
say('\n  DONE.\n');
say(`  On this machine:   http://localhost:${PORT}`);
say(`  From anywhere:     ${url}   (any device signed in to your tailnet)`);
say('');
for (const c of REMOTE_CAVEATS) say(`  · ${c}`);
say('');
