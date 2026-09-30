// Can Morpheus test the app on the machine the app is actually installed on?
//
// WHY THIS EXISTS (2026-09-30). Everything Morpheus knew about a generated app came from one of two places:
// a STATIC check over the file list, or a probe of a DEPLOYED URL. Neither can answer the question an
// operator asks — "does this thing work on MY machine?" — and today we paid for that gap: a desktop app
// built green on four platforms, downloaded, and died on first launch because PyInstaller had collected a
// Qt framework twice. The build machine could not have caught it. **The machine that runs the app is the
// only machine that can test it.**
//
// So the app has to be drivable WITHOUT A WINDOW, and it has to say so in a way that survives being copied
// to someone else's machine years later — with no Morpheus, no account and no network. That is this file:
//
//   1. THE CONTRACT — one command, `node selftest.mjs`, that starts the app headlessly, exercises a real
//      path, and prints ONE machine-readable line before exiting. Non-zero on failure.
//   2. THE PARSER — what Morpheus (or an installer, or a person) reads back.
//   3. THE RUNNER — Morpheus WRITES selftest.mjs INTO the app rather than asking a model to invent one.
//      Same reasoning as the portable launcher: one implementation, generated at build time, so no
//      committed copy can drift and no two apps test themselves differently.
//
// THE RULE THAT MATTERS MOST, and it is hazard H17 pointed at a test that runs on a stranger's laptop: **a
// self-test that printed nothing is NOT a pass.** Silence, a crash, a timeout and a missing runner are four
// different failures and every one of them must read as a failure. `parseSelfTestOutput` returns 'unknown'
// for anything it cannot positively read as ok, and 'unknown' never counts as verified.
//
// Pure and import-free so scripts/verify-app-selftest.mjs can drive every branch without an install.

/** The one command. Dependency-free, so it runs on a machine that has nothing but the app and Node. */
export const SELFTEST_FILE = 'selftest.mjs';

/**
 * Where a run leaves its RESULT, so the evidence outlives the terminal.
 *
 * A printed line is gone the moment the window closes, and the machine that ran the test is the machine
 * nobody can ask again. Writing the verdict next to the app means it can be read later — by the operator,
 * by the next Morpheus build of that project, or by the installer that asked for it. Deliberately inside
 * `.morpheus/`, which the generated app already treats as Morpheus bookkeeping and the export already
 * excludes: this is a record about the app, not part of it.
 */
export const SELFTEST_RESULT_FILE = '.morpheus/selftest.json';

/** The single line a run must print for its result to be readable. Last one wins. */
export const SELFTEST_MARKER = 'MORPHEUS-SELFTEST:';

/** Exit codes, kept distinct so a caller can tell "the app is broken" from "we could not ask". */
export const SELFTEST_EXIT = { ok: 0, appFailed: 1, couldNotRun: 2 };

const marker = (rest) => `${SELFTEST_MARKER} ${rest}`;

/**
 * What the operator is owed when the app does not answer for itself.
 *
 * Four outcomes, and only the first is good news. `unknown` exists because the alternative — treating
 * "printed nothing" as fine — is how a machine that never ran the test reads as a machine that passed it.
 */
export const SELFTEST_OUTCOMES = {
  ok: 'the app started headlessly and answered',
  failed: 'the app started and reported its own failure, with the reason',
  'could-not-run': 'the test could not be run at all — no runner, no dependency, no runtime',
  unknown: 'the test produced no readable result, so nothing is claimed',
};

/**
 * Read a run's output.
 *
 * The LAST marker line wins: a runner may print progress and then its verdict, and a verdict cannot be
 * undone by an earlier line. A missing marker is 'unknown' — never ok — and so is a marker with a shape
 * this does not recognise, because a parser that guesses is a parser that will one day guess "ok".
 */
export function parseSelfTestOutput(text) {
  const lines = String(text ?? '').split('\n').filter((l) => l.includes(SELFTEST_MARKER));
  if (!lines.length) return { status: 'unknown', detail: 'no result line was printed' };
  const last = lines[lines.length - 1].slice(lines[lines.length - 1].indexOf(SELFTEST_MARKER) + SELFTEST_MARKER.length).trim();
  if (/^ok\b/i.test(last)) return { status: 'ok', detail: last.replace(/^ok\s*[:-]?\s*/i, '') || '' };
  if (/^fail/i.test(last)) return { status: 'failed', detail: last.replace(/^fail(ed)?\s*[:-]?\s*/i, '') || 'the app reported a failure' };
  if (/^could-not-run/i.test(last)) return { status: 'could-not-run', detail: last.replace(/^could-not-run\s*[:-]?\s*/i, '') || 'the test could not run' };
  return { status: 'unknown', detail: `unreadable result line: ${last.slice(0, 80)}` };
}

/** Only a positive, readable `ok` counts as verified. Used by the installer and by any report to Morpheus. */
export function isVerified(result) {
  return result?.status === 'ok';
}

/**
 * The sentence a person is owed, and it never overstates.
 *
 * "Verified" is reserved for a run that actually answered; everything else names what did not happen,
 * because "we could not test it" and "it works" must not look the same on a screen.
 */
export function selfTestSummary(result, { where = 'this machine' } = {}) {
  switch (result?.status) {
    case 'ok': return `Verified on ${where}: the app started headlessly and answered.`;
    case 'failed': return `The app starts but fails its own test on ${where}: ${result.detail}.`;
    case 'could-not-run': return `Not verified on ${where} — the test could not be run: ${result.detail}.`;
    default: return `Not verified on ${where} — the test produced no readable result (${result?.detail ?? 'nothing was reported'}).`;
  }
}

/**
 * What a generated app must have for any of this to be possible.
 *
 * Kept as data, like RUNNABLE_APP_REQUIREMENTS, so a guard can assert the checklist is complete and that a
 * known-good app satisfies every item.
 */
export const SELFTEST_REQUIREMENTS = [
  {
    id: 'one-command',
    label: 'a single `npm start` that serves the app with no window and no arguments',
    why: 'every other check has to start the app the same way a person would, and a command that needs a display or a flag cannot be run on a build machine or in a support conversation',
  },
  {
    id: 'no-secrets-needed',
    label: 'it boots with the defaults it ships — no key, no account, no network',
    why: 'the machine running the test may have nothing configured, and a test that needs a credential is a test that gets skipped exactly when it matters',
  },
  {
    id: 'a-route-to-answer',
    label: 'at least one HTTP route (fullstack) or an index.html (static) to ask for',
    why: 'a headless test asserts a RESPONSE; with nothing to request, the only thing left to check is that the process stayed alive, which is what "a window that did nothing" looked like',
  },
];

const read = (files, path) => (files || []).find((f) => f && f.path === path);
const has = (files, re) => (files || []).some((f) => f && typeof f.path === 'string' && re.test(f.path));

/** Does this app ship what the self-test contract needs? Returns findings, each with the fix. */
export function selfTestProblems(files, { kind = 'fullstack' } = {}) {
  const problems = [];
  const pkg = read(files, 'package.json');
  let start = null;
  try { start = JSON.parse(pkg?.content || '{}')?.scripts?.start || null; } catch { start = null; }

  if (!start) {
    problems.push({
      id: 'no-start-script',
      title: 'There is no `npm start`, so nothing can start this app headlessly',
      why: 'The self-test contract is "start it the way a person would and ask it something". Without a start script there is no way to run the app on the machine it is installed on, and the only remaining check is that the files exist — which is what let a build that cannot launch look finished.',
      fix: 'Add `"start": "node server.js"` (or the app\'s real entry point) to package.json.',
    });
  }

  const ro = SELFTEST_REQUIREMENTS.find((r) => r.id === 'a-route-to-answer');
  const hasSomethingToAsk = kind === 'static' ? has(files, /(^|\/)index\.html$/) : has(files, /(^|\/)(server|app|index)\.(js|mjs|cjs)$/);
  if (!hasSomethingToAsk) {
    problems.push({
      id: 'nothing-to-ask',
      title: kind === 'static' ? 'No index.html, so there is nothing to request' : 'No server entry point, so there is nothing to request',
      why: ro.why,
      fix: kind === 'static' ? 'Ship an index.html at the root of the site.' : 'Ship the HTTP entry point the start script runs.',
    });
  }
  return problems;
}

/**
 * The runner Morpheus writes into the app.
 *
 * Written by us, not asked of a model, for the same reason the portable launcher is: one implementation
 * that cannot drift, and an app that tests itself the same way in every stack. Dependency-free on purpose —
 * it uses `node:child_process` and `node:http` and nothing else, because the machine it runs on may have
 * only the app and Node.
 *
 * It prints exactly one `MORPHEUS-SELFTEST:` line and exits 0, 1 or 2 (see SELFTEST_EXIT), so a caller can
 * tell "the app is broken" from "we could not ask it".
 */
export function renderSelfTestRunner({ port = 3111, path: probePath = '/', startCommand = 'npm start', timeoutMs = 60_000 } = {}) {
  return `#!/usr/bin/env node
// Written by Morpheus into this app. Do not edit by hand — regenerate it instead.
//
// Starts the app headlessly, asks it something, and prints ONE line:
//   ${SELFTEST_MARKER} ok
//   ${SELFTEST_MARKER} fail: <what went wrong>
//   ${SELFTEST_MARKER} could-not-run: <why we could not ask>
//
// It exits ${SELFTEST_EXIT.ok} when the app answered, ${SELFTEST_EXIT.appFailed} when the app started and failed, and
// ${SELFTEST_EXIT.couldNotRun} when the test could not be run at all. Nothing it prints is a substitute for the exit code,
// and the exit code is nothing without the line — a caller needs both to tell "broken" from "not tested".
import { spawn, spawnSync } from 'node:child_process';
import { get } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';

const PORT = process.env.SELFTEST_PORT || '${port}';
const PROBE = process.env.SELFTEST_PATH || '${probePath}';
const TIMEOUT_MS = Number(process.env.SELFTEST_TIMEOUT_MS || ${timeoutMs});
const started = Date.now();
const RESULT_FILE = '${SELFTEST_RESULT_FILE}';
const say = (rest, code) => {
  // Leave the result behind as well as printing it: the terminal closes, the machine that ran this cannot be
  // asked again, and "it worked on my machine" is only worth anything if something recorded it.
  try {
    const name = rest.split(':')[0].trim();
    const status = name === 'ok' ? 'ok' : (name === 'fail' ? 'failed' : 'could-not-run');
    mkdirSync(dirname(RESULT_FILE), { recursive: true });
    writeFileSync(RESULT_FILE, JSON.stringify({
      status, detail: rest.slice(name.length).replace(/^:\\s*/, ''), at: new Date().toISOString(),
      host: hostname(), platform: process.platform, command: '${startCommand}', exitCode: code,
    }, null, 2));
  } catch { /* a result we could not store must never change the verdict */ }
  console.log('${SELFTEST_MARKER} ' + rest);
  process.exit(code);
};

let child;

// Kill the whole process GROUP, and wait for it to actually be gone.
//
// The first version called child.kill(), which signals the SHELL that shell:true created and leaves the
// real server running. (No backticks in this comment: it lives inside the template literal below, where a
// stray backtick ends the generated source early — which is exactly what it did.) Measured in CI: the app from the first case stayed up, answered every later probe,
// and made four failing cases look like four passes — on a laptop the timing hid it. An installer that
// tests an app and leaves it running is its own bug, so this waits for the port to stop answering before
// the verdict is printed, and escalates to SIGKILL if the app ignores SIGTERM.
const stopAndWait = async () => {
  if (!child || child.killed) return;
  const pid = child.pid;
  const kill = (sig) => {
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(-pid, sig);   // negative pid = the process group
    } catch { try { child.kill(sig); } catch { /* already gone */ } }
  };
  kill('SIGTERM');
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const gone = await new Promise((resolve) => {
      const req = get({ host: '127.0.0.1', port: PORT, path: PROBE, timeout: 1000 }, (res) => { res.resume(); resolve(false); });
      req.on('timeout', () => { req.destroy(); resolve(true); });
      req.on('error', () => resolve(true));
    });
    if (gone) return;
  }
  kill('SIGKILL');
};

const ask = () => new Promise((resolve) => {
  const req = get({ host: '127.0.0.1', port: PORT, path: PROBE, timeout: 5000 }, (res) => {
    res.resume();
    resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode });
  });
  req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'timed out' }); });
  req.on('error', (e) => resolve({ ok: false, status: 0, error: e.code || e.message }));
});

try {
  child = spawn('${startCommand}', { shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(PORT), NODE_ENV: process.env.NODE_ENV || 'production' } });
} catch (e) {
  say('could-not-run: the start command could not be launched — ' + e.message, ${SELFTEST_EXIT.couldNotRun});
}

let output = '';
let exited = null;
child.stdout.on('data', (d) => { output += d; });
child.stderr.on('data', (d) => { output += d; });
child.on('error', (e) => say('could-not-run: ' + e.message, ${SELFTEST_EXIT.couldNotRun}));
child.on('exit', (code) => { exited = code; });

(async () => {
  // Poll until it answers or it dies or we run out of time. A process that dies early is the
  // "a window that did nothing" case, and it must say so rather than wait out the timeout.
  let last = { ok: false, status: 0 };
  while (Date.now() - started < TIMEOUT_MS) {
    if (exited !== null) {
      await stopAndWait();
      // 127 is the shell's "command not found" and 126 its "not executable" (9009 on cmd.exe). Those mean
      // the app was never STARTED, which is a different answer from "the app is broken" — the whole reason
      // there are two exit codes. Measured: without this, a wrong start command was reported as the app
      // failing, sending the reader to debug code that never ran.
      const cannotLaunch = exited === 126 || exited === 127 || exited === 9009;
      say((cannotLaunch ? 'could-not-run: the start command could not be launched (exit ' + exited + ')' : 'fail: the app exited with code ' + exited + ' before answering') + (output ? ' — ' + output.trim().split('\\n').slice(-3).join(' | ').slice(0, 400) : ''), cannotLaunch ? ${SELFTEST_EXIT.couldNotRun} : ${SELFTEST_EXIT.appFailed});
    }
    last = await ask();
    if (last.ok) { await stopAndWait(); say('ok: ' + PROBE + ' answered ' + last.status, ${SELFTEST_EXIT.ok}); }
    // An HTTP status IS an answer. The first version kept polling on a 404 or a 500 and then reported
    // "never answered", which is false and sends the reader looking for a server that is right there. Say
    // what it said, and say it immediately.
    if (last.status >= 400) { await stopAndWait(); say('fail: ' + PROBE + ' answered ' + last.status, ${SELFTEST_EXIT.appFailed}); }
    await new Promise((r) => setTimeout(r, 400));
  }
  await stopAndWait();
  say('fail: ' + PROBE + ' never answered within ' + TIMEOUT_MS + 'ms' + (last.error ? ' (last error: ' + last.error + ')' : '') + (output ? ' — ' + output.trim().split('\\n').slice(-3).join(' | ').slice(0, 400) : ''), ${SELFTEST_EXIT.appFailed});
})();
`;
}

/**
 * What to WRITE into the app so it can be tested where it runs.
 *
 * Morpheus authors this file rather than asking the coder for one, exactly like the portable launcher and
 * the provider-honesty README: one implementation that cannot drift, and no two apps testing themselves
 * differently. It returns null — and writes nothing — when it cannot be honest about it:
 *
 *   * the app already ships a selftest.mjs, so it is never overwritten;
 *   * there is no `npm start`, because a runner that cannot start the app would only be able to report
 *     could-not-run on the operator's machine, which is worse than not shipping one.
 */
export function planSelfTestFile(files) {
  if ((files || []).some((f) => f && f.path === SELFTEST_FILE)) return null;
  const pkg = (files || []).find((f) => f && f.path === 'package.json');
  let start = null;
  try { start = JSON.parse(pkg?.content || '{}')?.scripts?.start || null; } catch { start = null; }
  if (typeof start !== 'string' || !start.trim()) return null;
  return { path: SELFTEST_FILE, content: renderSelfTestRunner({ startCommand: start.trim() }) };
}

/**
 * Read a result file.
 *
 * Same rule as the printed line, and it matters more here because the file is read LATER, by something that
 * cannot ask a question: anything unreadable, out of shape or missing comes back `unknown`, and `unknown` is
 * never verified. A file that has been sitting on disk for a month is still evidence — of what happened then
 * — which is why the host and the time travel with it.
 */
export function parseSelfTestResult(value) {
  let data = value;
  if (typeof value === 'string') {
    try { data = JSON.parse(value); } catch { return { status: 'unknown', detail: 'the result file is not readable JSON' }; }
  }
  if (!data || typeof data !== 'object') return { status: 'unknown', detail: 'no result was recorded' };
  const status = ['ok', 'failed', 'could-not-run'].includes(data.status) ? data.status : 'unknown';
  return {
    status,
    detail: typeof data.detail === 'string' ? data.detail : '',
    at: typeof data.at === 'string' ? data.at : null,
    host: typeof data.host === 'string' ? data.host : null,
    command: typeof data.command === 'string' ? data.command : null,
  };
}

/** The last result recorded for an app, read out of its own files. Null when there is none. */
export function selfTestEvidence(files) {
  const f = (files || []).find((x) => x && x.path === SELFTEST_RESULT_FILE);
  if (!f) return null;
  return parseSelfTestResult(f.content);
}

/**
 * What the operator is owed when a build finds that this app was already tested on a machine — or is told
 * nothing when it was not. Silence is right for "no result": a build should not be padded with a line saying
 * nothing happened.
 */
export function selfTestEvidenceLine(evidence) {
  if (!evidence) return null;
  if (evidence.status === 'ok') {
    const where = evidence.host ? ` on ${evidence.host}` : ' on your machine';
    const when = evidence.at ? ` at ${evidence.at}` : '';
    return `// VERIFIED WHERE IT RUNS: this app passed its own headless self-test${where}${when}.`;
  }
  if (evidence.status === 'failed') {
    return `// LAST SELF-TEST FAILED${evidence.host ? ` on ${evidence.host}` : ''}: ${evidence.detail || 'the app reported a failure'}. Run \`node ${SELFTEST_FILE}\` again after fixing it.`;
  }
  if (evidence.status === 'could-not-run') {
    return `// SELF-TEST COULD NOT RUN${evidence.host ? ` on ${evidence.host}` : ''}: ${evidence.detail || 'the test could not start'}.`;
  }
  return null; // an unreadable record is not worth a sentence
}

/** The marker line a runner is expected to print, for tests and for the installer's own messages. */
export function expectedMarkerLine(status, detail = '') {
  return marker(status === 'ok' ? 'ok' : `${status === 'failed' ? 'fail' : 'could-not-run'}: ${detail}`.trim());
}
