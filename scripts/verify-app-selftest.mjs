// Can Morpheus test an app on the machine the app is installed on?
//
// WHY THIS EXISTS (2026-09-30). A desktop app built green on four platforms, was downloaded, and died on
// first launch because PyInstaller collected a Qt framework twice. No build machine could have caught it —
// the machine that RUNS the app is the only one that can test it. So a generated app must be drivable
// headlessly and must say so in a way that survives being copied to a stranger's machine with no Morpheus,
// no account and no network.
//
// This guard does more than assert the parser: it WRITES the generated runner into a temporary directory
// beside a real little app, RUNS it, and checks the exit code and the printed line. Reading a runner proves
// nothing about a runner — that is the lesson the app itself just taught us.
//
// The case that matters most is the last one: an app that starts, answers nothing and prints nothing must
// read as NOT VERIFIED. "No result" and "works" must never look the same (hazard H17, on a stranger's
// laptop, where nobody is watching).
//
// Run:  node scripts/verify-app-selftest.mjs
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  SELFTEST_FILE, SELFTEST_MARKER, SELFTEST_EXIT, SELFTEST_OUTCOMES, SELFTEST_REQUIREMENTS,
  parseSelfTestOutput, isVerified, selfTestSummary, selfTestProblems, renderSelfTestRunner,
} from '../server/src/lib/appSelfTest.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

console.log('\n1. silence is not a pass');
// The whole point. Four ways to learn nothing, and none of them may read as verified.
check('no output at all is unknown, not ok', parseSelfTestOutput('').status, 'unknown');
check('…and neither is output with no marker', parseSelfTestOutput('listening on 3000\nready\n').status, 'unknown');
check('a marker with an unreadable result is unknown', parseSelfTestOutput(`${SELFTEST_MARKER} maybe?`).status, 'unknown');
check('junk input does not crash it', parseSelfTestOutput(undefined).status, 'unknown');
check('none of those four is verified',
  ['', 'ready', `${SELFTEST_MARKER} hmm`].map((t) => isVerified(parseSelfTestOutput(t))), [false, false, false]);

console.log('\n2. and a real result is read exactly');
check('ok', parseSelfTestOutput(`${SELFTEST_MARKER} ok`), { status: 'ok', detail: '' });
check('ok carries its detail', parseSelfTestOutput(`${SELFTEST_MARKER} ok: / answered 200`).detail, '/ answered 200');
check('fail carries the reason', parseSelfTestOutput(`${SELFTEST_MARKER} fail: the app exited with code 1`), { status: 'failed', detail: 'the app exited with code 1' });
check('could-not-run is its own outcome, not a failure of the app', parseSelfTestOutput(`${SELFTEST_MARKER} could-not-run: no start script`).status, 'could-not-run');
// A runner may narrate and then give a verdict; a later line wins, and an earlier one cannot undo it.
check('the LAST marker line wins', parseSelfTestOutput(`${SELFTEST_MARKER} fail: early\nnoise\n${SELFTEST_MARKER} ok`).status, 'ok');
check('…and a later failure is not undone by an earlier ok', parseSelfTestOutput(`${SELFTEST_MARKER} ok\n${SELFTEST_MARKER} fail: then it died`).status, 'failed');
check('only ok is verified', [parseSelfTestOutput(`${SELFTEST_MARKER} fail: x`), parseSelfTestOutput(`${SELFTEST_MARKER} could-not-run: x`)].map(isVerified), [false, false]);

console.log('\n3. the sentence never overstates');
check('ok says verified', /^Verified on this machine/.test(selfTestSummary(parseSelfTestOutput(`${SELFTEST_MARKER} ok`))), true);
check('a failure names the reason', selfTestSummary({ status: 'failed', detail: 'exited with code 1' }).includes('exited with code 1'), true);
check('"could not run" never says verified', /^Not verified/.test(selfTestSummary({ status: 'could-not-run', detail: 'no node' })), true);
check('"unknown" never says verified', /^Not verified/.test(selfTestSummary({ status: 'unknown', detail: 'nothing' })), true);
check('every outcome has a written meaning', Object.keys(SELFTEST_OUTCOMES).sort(), ['could-not-run', 'failed', 'ok', 'unknown']);

console.log('\n4. what an app must ship for any of this to be possible');
const good = [
  { path: 'package.json', content: JSON.stringify({ scripts: { start: 'node server.js' } }) },
  { path: 'server.js', content: 'require("http")' },
];
check('a runnable app has no problems', selfTestProblems(good).map((p) => p.id), []);
// Only ONE finding here, and the first version of this assertion expected two: the fixture still ships
// `server.js`, so it does have something to ask — the missing piece is only the start script.
check('no start script is the finding that matters', selfTestProblems(good.filter((f) => f.path !== 'package.json')).map((p) => p.id), ['no-start-script']);
check('a fullstack app with no server entry has nothing to ask', selfTestProblems([good[0]]).map((p) => p.id), ['nothing-to-ask']);
check('a STATIC app is asked for an index.html instead', selfTestProblems([good[0], { path: 'index.html', content: '<html>' }], { kind: 'static' }).map((p) => p.id), []);
check('…and is a finding when it has none', selfTestProblems([good[0]], { kind: 'static' }).map((p) => p.id), ['nothing-to-ask']);
check('every finding carries a fix, not only a complaint', selfTestProblems([{ path: 'x', content: '' }]).every((p) => typeof p.fix === 'string' && p.fix.length > 20), true);
check('every requirement says why', SELFTEST_REQUIREMENTS.every((r) => typeof r.why === 'string' && r.why.length > 60), true);
check('junk does not crash it', Array.isArray(selfTestProblems(undefined)), true);

console.log('\n5. the runner Morpheus writes — RUN, not read');
// The only honest way to test a runner is to run it. Each case writes the generated file next to a real
// little app in a temp dir and executes it.
const dir = mkdtempSync(join(tmpdir(), 'morpheus-selftest-'));
const write = (p, c) => writeFileSync(join(dir, p), c);
const run = (port, env = {}) => spawnSync(process.execPath, [SELFTEST_FILE], {
  cwd: dir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, SELFTEST_PORT: port, ...env },
});
// A DISTINCT PORT PER CASE. Measured in CI, and the reason this guard is worth more than it looks: with one
// shared port, an app left running by an earlier case answered the later probes and four failing cases
// reported four passes. Distinct ports make that impossible; the check after the first case below asserts
// the runner did not leave the app behind in the first place.
// The fallback baked into the generated file. Each case passes SELFTEST_PORT instead, so no two cases can
// ever share a port — which is the bug this guard was rewritten for.
const RENDERED_DEFAULT_PORT = '3209';
let nextPort = 3210;
const takePort = () => String(nextPort++);
const portAnswers = async (port) => {
  const { get } = await import('node:http');
  return new Promise((resolve) => {
    const req = get({ host: '127.0.0.1', port, path: '/', timeout: 1200 }, (res) => { res.resume(); resolve(true); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
};

try {
  // (a) an app that starts and answers
  write('app-ok.js', `require('node:http').createServer((_, res) => { res.writeHead(200); res.end('hi'); }).listen(process.env.PORT);`);
  write(SELFTEST_FILE, renderSelfTestRunner({ port: RENDERED_DEFAULT_PORT, startCommand: 'node app-ok.js', timeoutMs: 20_000 }));
  const okPort = takePort();
  const ok = run(okPort);
  const okResult = parseSelfTestOutput(ok.stdout);
  check('a working app prints ok', okResult.status, 'ok');
check('…and exits 0', ok.status, SELFTEST_EXIT.ok);
  check('…and the line is the one the contract names', ok.stdout.includes(`${SELFTEST_MARKER} ok`), true);

  // (b) an app that starts and answers nothing — the smoke test that only proves it is alive
  write('app-quiet.js', `setInterval(() => {}, 1000);`);
  write(SELFTEST_FILE, renderSelfTestRunner({ port: RENDERED_DEFAULT_PORT, startCommand: 'node app-quiet.js', timeoutMs: 4000 }));
  const quiet = run(takePort());
  check('an app that never answers FAILS rather than passing as alive', parseSelfTestOutput(quiet.stdout).status, 'failed');
  check('…and exits 1, not 0', quiet.status, SELFTEST_EXIT.appFailed);

  // (c) an app that dies immediately — the "it opened a window that did nothing" case
  write('app-dead.js', `console.error('boom: missing dependency'); process.exit(3);`);
  write(SELFTEST_FILE, renderSelfTestRunner({ port: RENDERED_DEFAULT_PORT, startCommand: 'node app-dead.js', timeoutMs: 20_000 }));
  const dead = run(takePort());
  check('an app that exits early is reported with its code and its last output',
    /exited with code 3/.test(parseSelfTestOutput(dead.stdout).detail) && /boom/.test(parseSelfTestOutput(dead.stdout).detail), true);
  check('…and exits 1', dead.status, SELFTEST_EXIT.appFailed);

  // (d) nothing to run at all — must be distinguishable from the app being broken
  write(SELFTEST_FILE, renderSelfTestRunner({ port: RENDERED_DEFAULT_PORT, startCommand: 'this-command-does-not-exist-xyz', timeoutMs: 6000 }));
  const missing = run(takePort());
  check('a start command that cannot be launched is could-not-run, not a broken app',
    parseSelfTestOutput(missing.stdout).status, 'could-not-run');
  check('…and exits 2, so a caller can tell "not tested" from "broken"', missing.status, SELFTEST_EXIT.couldNotRun);

  // (e) the parser against a runner that printed nothing at all
  check('a runner that printed nothing is not verified', isVerified(parseSelfTestOutput(run(takePort()).stdout)), false);

  // THE ORPHAN CHECK, and it is the one CI bought: on a laptop the app died fast enough to hide it, while in
  // CI the app from the first case was still listening and answered four later cases as passes. The runner
  // now kills the process group AND waits for the port to stop answering.
  //
  // The detector is proved FIRST, on a listener deliberately left up. Without that, a `false` below would be
  // indistinguishable from a detector that can never say true — a check that cannot fail reading as a check
  // that passed, which is the hazard this whole file is about.
  const strayPort = takePort();
  const stray = spawn(process.execPath, ['-e', `require('node:http').createServer((_, r) => { r.writeHead(200); r.end(); }).listen(${strayPort})`], { stdio: 'ignore', detached: process.platform !== 'win32' });
  await new Promise((r) => setTimeout(r, 800));
  check('the orphan detector SEES a listener that is really there', await portAnswers(strayPort), true);
  try { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(stray.pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(-stray.pid, 'SIGKILL'); } catch { stray.kill('SIGKILL'); }
  await new Promise((r) => setTimeout(r, 400));
  check('…and stops seeing it once it is gone', await portAnswers(strayPort), false);
  check('…so a successful run leaving NOTHING behind it is a real result', await portAnswers(okPort), false);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ an app cannot be tested on the machine it is installed on, or a silent test reads as a pass\n');
  process.exit(1);
}
console.log('a generated app can be started and asked headlessly, and only a readable "ok" counts as verified\n');
