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
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  SELFTEST_FILE, SELFTEST_MARKER, SELFTEST_EXIT, SELFTEST_OUTCOMES, SELFTEST_REQUIREMENTS,
  parseSelfTestOutput, isVerified, selfTestSummary, selfTestProblems, renderSelfTestRunner, planSelfTestFile,
  SELFTEST_RESULT_FILE, parseSelfTestResult, selfTestEvidence, selfTestEvidenceLine,
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

console.log('\n4b. the runner Morpheus WRITES INTO the app');
// The file is authored by Morpheus, so the app ships a test it did not have to invent.
const nodeApp = [
  { path: 'package.json', content: JSON.stringify({ scripts: { start: 'node server.js' } }) },
  { path: 'server.js', content: 'x' },
];
const plan = planSelfTestFile(nodeApp);
check('a runnable Node app gets a runner', plan?.path, SELFTEST_FILE);
check('…and it starts the app the app itself starts', plan.content.includes('node server.js'), true);
check('…and it speaks the same contract as the one we test here', plan.content.includes(SELFTEST_MARKER), true);
// Three refusals, each for a reason. A runner that cannot start the app could only ever report
// could-not-run on the operator machine, which is worse than shipping nothing.
check('no start script means no runner', planSelfTestFile([{ path: 'server.js', content: 'x' }]), null);
check('a package.json with no start script means no runner',
  planSelfTestFile([{ path: 'package.json', content: JSON.stringify({ scripts: { dev: 'vite' } }) }]), null);
check('an unparseable package.json means no runner',
  planSelfTestFile([{ path: 'package.json', content: 'not json' }]), null);
check('an app that already ships one is never overwritten',
  planSelfTestFile([...nodeApp, { path: SELFTEST_FILE, content: '// mine' }]), null);
check('junk does not crash it', planSelfTestFile(undefined), null);

console.log('\n4c. the result survives the terminal');
// A printed line dies with the window, and the machine that ran the test is the one nobody can ask again.
check('a stored ok is read back as ok', parseSelfTestResult(JSON.stringify({ status: 'ok', host: 'mac', at: 'now' })).status, 'ok');
// A file is read LATER, by something that cannot ask a question, so it gets the same treatment as the line.
check('an unreadable file is unknown, never ok', parseSelfTestResult('{not json').status, 'unknown');
check('a file with no status is unknown', parseSelfTestResult('{}').status, 'unknown');
check('a made-up status is unknown, not taken at its word', parseSelfTestResult({ status: 'probably' }).status, 'unknown');
check('nothing at all is unknown', [parseSelfTestResult(undefined), parseSelfTestResult(null)].map((r) => r.status), ['unknown', 'unknown']);
check('host and time travel with the verdict', parseSelfTestResult({ status: 'ok', host: 'mac', at: '2026-10-01' }).host, 'mac');
// Reading it out of an app, and saying something only when there is something to say.
check('no result file means no evidence', selfTestEvidence([{ path: 'index.js', content: '' }]), null);
check('…and no evidence means no line', selfTestEvidenceLine(null), null);
check('…and an unreadable record is not worth a sentence', selfTestEvidenceLine(parseSelfTestResult('x')), null);
check('an ok result reads as verified where it runs',
  /VERIFIED WHERE IT RUNS/.test(selfTestEvidenceLine({ status: 'ok', host: 'mac', at: '2026-10-01T00:00:00Z' })), true);
check('…naming the machine and the time',
  selfTestEvidenceLine({ status: 'ok', host: 'mac', at: '2026-10-01T00:00:00Z' }).includes('mac') && selfTestEvidenceLine({ status: 'ok', host: 'mac', at: '2026-10-01T00:00:00Z' }).includes('2026-10-01'), true);
check('a failure is reported with its reason, not as a pass',
  /LAST SELF-TEST FAILED/.test(selfTestEvidenceLine({ status: 'failed', detail: 'exited with code 1' })), true);
check('a test that could not run says exactly that',
  /COULD NOT RUN/.test(selfTestEvidenceLine({ status: 'could-not-run', detail: 'no node' })), true);

// ESCAPES INSIDE THE TEMPLATE. The runner is generated from a template literal, so a single backslash can
// collapse before it is ever written: `/^:\s*/` in the outer file emits `/^:s*/` into the app, which strips
// the wrong characters and cannot be seen by reading the generator. Lint caught it once; this keeps it caught.
check('backslashes survive into the generated runner',
  renderSelfTestRunner({ startCommand: 'node s.js' }).includes('replace(/^:\\s*/'), true);
// The broken form is the literal `:s*` (the backslash collapsed); the correct one is `:\s*`.
check('…and no generated line contains a collapsed escape',
  renderSelfTestRunner({ startCommand: 'node s.js' }).includes(':s*'), false);

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
  // Written by the RUN, then read back the way Morpheus would — the whole point of storing it.
  const stored = selfTestEvidence([{ path: SELFTEST_RESULT_FILE, content: readFileSync(join(dir, SELFTEST_RESULT_FILE), 'utf8') }]);
  check('…and the run left a result file beside the app', stored?.status, 'ok');
  check('…carrying the machine that ran it', typeof stored?.host === 'string' && stored.host.length > 0, true);
  check('…and the command it used', stored?.command, 'node app-ok.js');

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
  // A FAILING run overwrites the good result — a stale "ok" next to a broken app is the worst outcome here.
  check('a later failure replaces the stored ok',
    selfTestEvidence([{ path: SELFTEST_RESULT_FILE, content: readFileSync(join(dir, SELFTEST_RESULT_FILE), 'utf8') }])?.status, 'failed');
  check('an app that exits early is reported with its code and its last output',
    /exited with code 3/.test(parseSelfTestOutput(dead.stdout).detail) && /boom/.test(parseSelfTestOutput(dead.stdout).detail), true);
  check('…and exits 1', dead.status, SELFTEST_EXIT.appFailed);

  // (d) nothing to run at all — must be distinguishable from the app being broken
  write(SELFTEST_FILE, renderSelfTestRunner({ port: RENDERED_DEFAULT_PORT, startCommand: 'this-command-does-not-exist-xyz', timeoutMs: 6000 }));
  const missing = run(takePort());
  check('a start command that cannot be launched is could-not-run, not a broken app',
    parseSelfTestOutput(missing.stdout).status, 'could-not-run');
  check('…and exits 2, so a caller can tell "not tested" from "broken"', missing.status, SELFTEST_EXIT.couldNotRun);

  // (d2) an app that is up but answers 404 — the failure the first runner hid behind a timeout
  write('app-404.js', `require('node:http').createServer((_, res) => { res.writeHead(404); res.end('no'); }).listen(process.env.PORT);`);
  write(SELFTEST_FILE, renderSelfTestRunner({ port: RENDERED_DEFAULT_PORT, startCommand: 'node app-404.js', timeoutMs: 9000 }));
  const notFound = run(takePort());
  check('an HTTP error status is reported as an answer, not as silence',
    parseSelfTestOutput(notFound.stdout).detail.includes('404'), true);
  check('…and it still exits 1, because a 404 root is not a working app', notFound.status, SELFTEST_EXIT.appFailed);

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

console.log('\n6. the app is actually given one');
// A writer nobody calls is a file that never ships. Asserted on comment-stripped source, because a guard
// satisfied by the comment explaining the fix is this repo's most-repeated mistake.
const cwm = readFileSync(join(ROOT, 'server/src/functions/chatWithMorpheus.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
check('the build writes the runner into the app', /planSelfTestFile\(/.test(cwm), true);
// Through the ONE write path, not a raw upsert: applyFileOperations is what snapshots and syncs it.
check('…through applyFileOperations, so it is snapshotted and synced like any other file',
  /await applyFileOperations\(userId, projectId, \[\{ path: plan\.path/.test(cwm), true);
check('…and a failure to write it never costs the operator the build', /self-test runner write failed/.test(cwm), true);
// The evidence is only worth storing if a later build READS it and says so.
check('a build reads what the last self-test recorded', /selfTestEvidence\(withRunner\)/.test(cwm), true);
check('…and tells the operator, but only when there is something to tell',
  /if \(evidenceLine\) fullReply/.test(cwm), true);
check('…and the operator is told the command', /TO PROVE IT RUNS WHERE YOU RUN IT/.test(readFileSync(join(ROOT, 'server/src/functions/chatWithMorpheus.js'), 'utf8')), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ an app cannot be tested on the machine it is installed on, or a silent test reads as a pass\n');
  process.exit(1);
}
console.log('a generated app can be started and asked headlessly, and only a readable "ok" counts as verified\n');
