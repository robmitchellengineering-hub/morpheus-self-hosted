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
import { spawn } from 'node:child_process';
import { get } from 'node:http';

const PORT = process.env.SELFTEST_PORT || '${port}';
const PROBE = process.env.SELFTEST_PATH || '${probePath}';
const TIMEOUT_MS = Number(process.env.SELFTEST_TIMEOUT_MS || ${timeoutMs});
const started = Date.now();
const say = (rest, code) => { console.log('${SELFTEST_MARKER} ' + rest); process.exit(code); };

let child;
const stop = () => { try { if (child && !child.killed) child.kill('SIGTERM'); } catch { /* already gone */ } };

const ask = () => new Promise((resolve) => {
  const req = get({ host: '127.0.0.1', port: PORT, path: PROBE, timeout: 5000 }, (res) => {
    res.resume();
    resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode });
  });
  req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'timed out' }); });
  req.on('error', (e) => resolve({ ok: false, status: 0, error: e.code || e.message }));
});

try {
  child = spawn('${startCommand}', { shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(PORT), NODE_ENV: process.env.NODE_ENV || 'production' } });
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
      stop();
      // 127 is the shell's "command not found" and 126 its "not executable" (9009 on cmd.exe). Those mean
      // the app was never STARTED, which is a different answer from "the app is broken" — the whole reason
      // there are two exit codes. Measured: without this, a wrong start command was reported as the app
      // failing, sending the reader to debug code that never ran.
      const cannotLaunch = exited === 126 || exited === 127 || exited === 9009;
      say((cannotLaunch ? 'could-not-run: the start command could not be launched (exit ' + exited + ')' : 'fail: the app exited with code ' + exited + ' before answering') + (output ? ' — ' + output.trim().split('\\n').slice(-3).join(' | ').slice(0, 400) : ''), cannotLaunch ? ${SELFTEST_EXIT.couldNotRun} : ${SELFTEST_EXIT.appFailed});
    }
    last = await ask();
    if (last.ok) { stop(); say('ok: ' + PROBE + ' answered ' + last.status, ${SELFTEST_EXIT.ok}); }
    await new Promise((r) => setTimeout(r, 400));
  }
  stop();
  say('fail: ' + PROBE + ' never answered within ' + TIMEOUT_MS + 'ms' + (last.error ? ' (last error: ' + last.error + ')' : '') + (output ? ' — ' + output.trim().split('\\n').slice(-3).join(' | ').slice(0, 400) : ''), ${SELFTEST_EXIT.appFailed});
})();
`;
}

/** The marker line a runner is expected to print, for tests and for the installer's own messages. */
export function expectedMarkerLine(status, detail = '') {
  return marker(status === 'ok' ? 'ok' : `${status === 'failed' ? 'fail' : 'could-not-run'}: ${detail}`.trim());
}
