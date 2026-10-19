// Stop a local Portable Morpheus.
//
//   npm run portable:stop
//
// The server is deliberately NOT hunted down and killed here. It runs in the foreground of whatever
// window started it, so closing that window or pressing Ctrl+C is the stop — visible, immediate, and
// impossible to get wrong. What a launcher cannot do by closing a window is the DATABASE, which
// `dev-db.mjs start` leaves running as a daemon on purpose (see its header). So this stops the cluster
// and says plainly what it did and did not touch.
//
// Nothing is deleted: the cluster keeps its data under server/data/pg for the next start.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'server');
const DEV_DB = join(SERVER, 'scripts', 'dev-db.mjs');
const say = (s) => console.log(s);

say('\n  PORTABLE MORPHEUS — stop');

if (!existsSync(DEV_DB)) {
  say('\n  ✗ server/scripts/dev-db.mjs is missing — nothing to stop.\n');
  process.exit(1);
}

const status = spawnSync(process.execPath, [DEV_DB, 'status'], { cwd: SERVER, encoding: 'utf8' });
const wasRunning = /running:\s*yes/i.test(status.stdout || '');

const stop = spawnSync(process.execPath, [DEV_DB, 'stop'], { cwd: SERVER, encoding: 'utf8' });
const out = `${stop.stdout || ''}${stop.stderr || ''}`.trim();

if (stop.status !== 0) {
  say(`\n  ✗ the database would not stop:\n${out.split('\n').slice(-6).join('\n')}\n`);
  process.exit(1);
}
say(wasRunning ? '      ✓ local database stopped (its data is kept)' : '      · local database was not running');

// The honest half: this command cannot close someone else's terminal window, and saying "stopped"
// while the server still answers would be the same lie as claiming a deploy went live unchecked.
try {
  const res = await fetch('http://127.0.0.1:4500/api/health', { signal: AbortSignal.timeout(1500) });
  if (res.ok) {
    say('      ! the server is STILL RUNNING — close its window or press Ctrl+C there.');
    say('        (This command stops the database; the server owns the window that started it.)');
  }
} catch {
  say('      ✓ the server is not answering, so nothing is left running');
}
say('');
