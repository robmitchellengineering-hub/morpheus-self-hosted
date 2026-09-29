// Start a local Portable Morpheus — the everyday command, and what the launchers run.
//
//   npm run portable:start              # start it (idempotent: if it is already up, just opens the browser)
//   npm run portable:start -- --no-open # start it without opening a browser
//   npm run portable:stop               # stop the local database (the server stops with its window)
//
// WHAT IT DOES, in order: check the install exists, make sure the local Postgres cluster is running,
// start the server IN THIS WINDOW so the log is visible and Ctrl+C stops it, and open the browser only
// once /api/health answers — opening first is how a launcher shows someone a connection-refused page and
// calls it a success.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_ENV } from '../server/src/lib/portableSetup.js';
import { HEALTH_PATH, READY_TIMEOUT_MS, READY_POLL_MS, START_STEPS, startedMessage } from '../server/src/lib/portableLaunch.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'server');
const ENV_PATH = join(SERVER, '.env');
const DEV_DB = join(SERVER, 'scripts', 'dev-db.mjs');
const PORT = Number(LOCAL_ENV.PORT);
const argv = process.argv.slice(2);
const NO_OPEN = argv.includes('--no-open');
const say = (s) => console.log(s);

const healthy = async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${HEALTH_PATH}`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
};

/** Open the default browser, per platform. Best-effort: failing to open one must not stop the server. */
function openBrowser() {
  const cmd = process.platform === 'darwin' ? ['open', [`http://localhost:${PORT}`]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', `http://localhost:${PORT}`]]
      : ['xdg-open', [`http://localhost:${PORT}`]];
  try { spawnSync(cmd[0], cmd[1], { stdio: 'ignore' }); } catch { /* the URL is printed anyway */ }
}

say('\n  PORTABLE MORPHEUS — start');

if (!existsSync(ENV_PATH)) {
  say('\n  ✗ server/.env is missing, so this install has not been set up yet.');
  say('    Run: npm run portable:setup\n');
  process.exit(2);
}
say(`      ✓ ${START_STEPS[0].title}`);

// Already running? Then this is a "bring me to it" command, not a start.
if (await healthy()) {
  say(`      ✓ already running on http://localhost:${PORT}`);
  if (!NO_OPEN) openBrowser();
  say('');
  process.exit(0);
}

if (!existsSync(DEV_DB)) {
  say(`\n  ✗ ${DEV_DB} is missing — this install is incomplete. Re-run: npm run portable:setup\n`);
  process.exit(1);
}
say(`      … ${START_STEPS[1].title}`);
const db = spawnSync(process.execPath, [DEV_DB, 'start'], { cwd: SERVER, encoding: 'utf8' });
if (db.status !== 0) {
  say(`\n  ✗ the local database would not start:\n${(db.stderr || db.stdout || '').trim().split('\n').slice(-6).join('\n')}\n`);
  process.exit(1);
}

say(`      … ${START_STEPS[2].title}`);
const server = spawn(process.execPath, ['src/index.js'], { cwd: SERVER, stdio: 'inherit' });

// Wait for the server to answer, then open the browser. Bounded, and the timeout says what to look at
// rather than silently giving up.
(async () => {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await healthy()) {
      say(`      ✓ ${START_STEPS[3].title}`);
      say(`\n${startedMessage(PORT)}\n`);
      if (!NO_OPEN) openBrowser();
      return;
    }
    if (server.exitCode !== null) return; // it died; its own output is above
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
  say(`\n  ! The server has not answered ${HEALTH_PATH} after ${Math.round(READY_TIMEOUT_MS / 1000)}s.`);
  say('    It may still be starting. Read the log above for the reason, then try the URL again.\n');
})();

// The server owns this terminal: Ctrl+C or a closed window stops it, which is what a launcher's user
// expects. Nothing is left running in the background that they cannot see.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { server.kill(sig); } catch { /* already gone */ } });
}
server.on('exit', (code) => process.exit(code ?? 0));
