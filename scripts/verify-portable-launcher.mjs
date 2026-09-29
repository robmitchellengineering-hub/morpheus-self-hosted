// Does the one-click path actually work, and does it avoid the two lies a launcher tells?
//
// WHY THIS EXISTS. Two failure modes are specific to a launcher, and both look like success:
//
//   1. Opening the browser BEFORE the server answers, so the first thing the operator sees is
//      "connection refused" while the script says it started. `portable-start.mjs` waits for
//      /api/health first, and this asserts that ordering.
//   2. A stop command that reports "stopped" while the server is still answering. The server runs in
//      the foreground of its own window, so what `portable:stop` can honestly stop is the DATABASE —
//      it then checks the server and says plainly whether it is still up.
//
// It also asserts the launchers are GENERATED into the bundle rather than committed beside the rule
// that describes them, and that the one thing they cannot do for the operator (being unsigned) is
// stated instead of discovered.
//
// Dependency-free except for the read-only execution at the end, so it runs in CI's no-install job.
//
// Run:  node scripts/verify-portable-launcher.mjs
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LAUNCHERS, launcherFor, START_STEPS, PORTABLE_GATEKEEPER_NOTE, OPEN_AFTER_HEALTHY_WHY,
  HEALTH_PATH, READY_TIMEOUT_MS, LOCAL_PORT, startedMessage,
} from '../server/src/lib/portableLaunch.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

console.log('\n1. a launcher per platform, and none of them clever');
check('macOS, Windows and Linux are covered', LAUNCHERS.map((l) => l.platform).sort().join(','), 'darwin,linux,win32');
check('each one has a filename that says what it is',
  LAUNCHERS.every((l) => /^Portable-Morpheus\.(command|bat|desktop)$/.test(l.file)), true);
check('an unknown platform gets no launcher rather than a wrong one', launcherFor('sunos'), null);
check('the mac launcher is a bash script with a shebang', /^#!\/bin\/bash\n/.test(launcherFor('darwin').body), true);
check('…and it explains the quarantine step in the file itself',
  /xattr -d com\.apple\.quarantine/.test(launcherFor('darwin').body), true);
check('the Windows launcher is a batch file that does not close the window', /^@echo off\n/.test(launcherFor('win32').body) && /\npause\n/.test(launcherFor('win32').body), true);
check('the Linux launcher is a .desktop entry with a terminal', /\[Desktop Entry\]/.test(launcherFor('linux').body) && /Terminal=true/.test(launcherFor('linux').body), true);

console.log('\n2. they delegate, they do not reimplement');
for (const l of LAUNCHERS) {
  check(`${l.label}: runs the one start command`, /npm run portable:start/.test(l.body), true);
}
check('no launcher starts a database or a server itself',
  LAUNCHERS.some((l) => /dev-db|src\/index\.js|node scripts/.test(l.body)), false);

console.log('\n3. they are generated into the bundle, not committed twice');
const gen = read('scripts/build-portable-bundle.mjs');
check('the bundle generator writes them from the rule', /for \(const l of LAUNCHERS\)/.test(gen) && /LAUNCHERS/.test(gen), true);
check('…with an exec bit, because a .command without one does not double-click',
  /unixPermissions: 0o755/.test(gen), true);
// MEASURED, not assumed: the first build set unixPermissions and still shipped every launcher as
// 0644, because JSZip ignores Unix permissions unless the archive is generated with platform 'UNIX'.
// A .command at 0644 opens in a text editor when double-clicked — the whole feature, silently off.
// Anchored at the CALL, not the file: the first version of this assertion matched the explanatory
// comment that says the same words, so deleting the option still passed. (Third time in this
// codebase a text check matched its own prose — assert on the code, not on the reason for it.)
check('…and the archive declares platform UNIX, or the exec bit is never written',
  /generateAsync\(\{[\s\S]{0,200}platform: 'UNIX'/.test(gen), true);
check('…and no launcher is committed beside it',
  LAUNCHERS.some((l) => existsSync(join(ROOT, l.file))), false);

console.log('\n4. the browser opens after the server answers, never before');
const start = read('scripts/portable-start.mjs');
const healthIdx = start.indexOf('await healthy()');
const openIdx = start.indexOf('openBrowser();', healthIdx);
check('it checks health before opening', healthIdx > 0 && openIdx > healthIdx, true);
check('…and says why, in words', /connection-refused page/.test(OPEN_AFTER_HEALTHY_WHY), true);
check('the health check is the real endpoint', `/api/health`, HEALTH_PATH);
check('the wait is bounded, so a broken start does not hang forever', READY_TIMEOUT_MS > 0 && READY_TIMEOUT_MS <= 180_000, true);
check('a missing install is refused with the command that fixes it', /Run: npm run portable:setup/.test(start), true);

console.log('\n5. starting twice is a "bring me to it", not a second server');
check('an already-answering server short-circuits', /if \(await healthy\(\)\) \{/.test(start) && /already running/.test(start), true);
check('…and it still opens the browser', /if \(!NO_OPEN\) openBrowser\(\);\n  say\(''\);\n  process\.exit\(0\);/.test(start), true);
check('the steps are a real sequence', START_STEPS.length >= 4 && START_STEPS.every((s) => s.id && s.title), true);
check('the operator is told where to go and how to stop', /http:\/\/localhost:4500/.test(startedMessage()) && /Ctrl\+C/.test(startedMessage()), true);

console.log('\n6. stopping says what it did NOT stop');
const stop = read('scripts/portable-stop.mjs');
check('it stops the database through the script that owns it', /\[DEV_DB, 'stop'\]/.test(stop), true);
// The honest half: it cannot close someone else's window, and claiming "stopped" while the server
// answers is the same lie as claiming an unchecked deploy went live.
check('…then checks whether the server is still up', /api\/health/.test(stop) && /STILL RUNNING/.test(stop), true);
check('…and says the data is kept, not deleted', /its data is kept/.test(stop), true);

console.log('\n7. the thing it cannot do for you is stated');
check('the unsigned-launcher caveat exists', /not a signed app/.test(PORTABLE_GATEKEEPER_NOTE), true);
check('…and the setup prints it', /PORTABLE_GATEKEEPER_NOTE/.test(read('scripts/portable-setup.mjs')), true);
check('…naming the mac and Windows steps', /right-click → Open/.test(PORTABLE_GATEKEEPER_NOTE) && /SmartScreen/.test(PORTABLE_GATEKEEPER_NOTE), true);
check('the installer names a launcher for this platform', /Launcher:/.test(read('scripts/portable-setup.mjs')), true);

console.log('\n8. the honest list moved with it');
const setup = read('server/src/lib/portableSetup.js');
check('it no longer claims there is no double-clickable package',
  /not a double-clickable package/.test(setup), false);
check('…and now names signing and auto-update as what is missing',
  /signed native app/.test(setup) && /auto-update/.test(setup), true);
check('reality.mjs reports the launcher', /portable-start|launcher/i.test(read('scripts/reality.mjs')), true);

console.log('\n9. the read-only path runs');
// The lesson from the remote work: a wrong import passes every text assertion above.
const proc = spawnSync(process.execPath, [join(ROOT, 'scripts/portable-stop.mjs')], { encoding: 'utf8', timeout: 60000 });
const said = `${proc.stdout}${proc.stderr}`;
check('stop is safe to run with nothing installed', /PORTABLE MORPHEUS — stop/.test(said), true);
check('…and prints no stack trace', /SyntaxError|ERR_MODULE_NOT_FOUND|at ModuleJob/.test(said), false);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ the launcher could show someone an error page and call it started\n');
  process.exit(1);
}
console.log('one double-click starts it, the browser waits for the server, and stopping tells the truth\n');
