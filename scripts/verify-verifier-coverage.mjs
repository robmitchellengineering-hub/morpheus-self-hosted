// A verifier that examined nothing must not report ok.
//
// WHY THIS EXISTS
//
// `verifyProject` returned `ok: true, errorCount: 0, checkedFiles: 0` for the
// WikiData Batch Uploader — a 37-file Python desktop app. It reads only JS/TS, so
// every pass inside it had nothing to look at, and its success condition is "no
// errors were found". Zero files examined yields zero errors, which is
// indistinguishable from a clean bill of health.
//
// That is hazard H17 in a new coat: "nothing failed" is not "nothing to check".
// It matters more than most because every non-JS compile target Morpheus supports
// (windows-exe, mac-app, android-apk, python-package, arduino-firmware, …) sits in
// exactly that position, and a silent pass is the one answer nobody questions.
//
// The logic is pure (server/src/lib/engine/verificationCoverage.js) so it can be
// asserted here, in CI's no-install guards job, rather than behind verify.js's
// esbuild import.
//
// Dependency-free. Run:  node scripts/verify-verifier-coverage.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coverageError, coverageVerdict } from '../server/src/lib/engine/verificationCoverage.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const problems = [];

function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    if (detail) console.log(`          ${detail}`);
    problems.push(name);
  }
  ok ? pass++ : fail++;
}

console.log('\nA check that examined nothing does not get to say ok\n');

// ── the rule itself ─────────────────────────────────────────────────────────
const nothingToRead = coverageError({ codeFiles: 0, files: 37 });
check('files present but none readable is an error', !!nothingToRead);
check('…and says how many files went unread', /37 file\(s\)/.test(nothingToRead?.text || ''), nothingToRead?.text);
check('…naming the real cause: this verifier reads only JS/TS',
  /none of them JS\/TS/.test(nothingToRead?.text || ''), nothingToRead?.text);

const empty = coverageError({ codeFiles: 0, files: 0 });
check('a wholly empty file set is an error too', !!empty);
check('…with its own wording, so the two cases are not conflated',
  /no files to check at all/.test(empty?.text || ''), empty?.text);

// The rule must not fire on a normal project — a gate that cries wolf is a gate
// that gets switched off.
check('one readable file is enough to pass', coverageError({ codeFiles: 1, files: 40 }) === null);
check('and the default (nothing passed in) is treated as nothing to read',
  !!coverageError(), 'a call with no counts must not read as verified');

// ── and the verifier actually consults it ───────────────────────────────────
const raw = readFileSync(join(REPO, 'server/src/lib/engine/verify.js'), 'utf8');
// Comment-masked, because a check that matches its own explanatory prose proves the
// prose exists — a mistake already made once in this repo today.
const src = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
check('the verifier imports the rule', /import \{ coverageError \} from '\.\/verificationCoverage\.js'/.test(src));
check('…and pushes it into the same error list everything else uses',
  /const coverage = coverageError\(\{ codeFiles: codeFiles\.length, files: kept\.length \}\)/.test(src)
  && /if \(coverage\) errors\.push\(coverage\)/.test(src));
// Ordering: coverage must be decided from the counts the other passes used, and
// before the dedupe that decides `ok`.
const coverageAt = src.indexOf('const coverage = coverageError(');
const seenAt = src.indexOf('const seen = new Set();');
const okAt = src.indexOf('ok: unique.length === 0');
check('the three anchors were found', coverageAt > -1 && seenAt > -1 && okAt > -1);
check('…it is decided before the success condition is computed', coverageAt < seenAt && coverageAt < okAt);

// ── the three-state verdict: not a pass, and not a failure either ───────────
// verify.js can afford to fold coverage into its error list: it is Morpheus's own
// repo, where every change is JS/TS. A target whose NORMAL change is a language
// this backend cannot read is different — a WordPress theme's PHP — and calling
// that "failed" is a gate that cries wolf, while calling it "ok" is the silent
// pass above. So it gets its own state, and its own code.
console.log('\n-- the verdict has three states, and "not verified" is one of them --');
const phpOnly = coverageVerdict({ errors: [], codeFiles: 0, files: 3 });
check('a PHP-only file set is not a pass', phpOnly.ok === false, JSON.stringify(phpOnly));
check('…it is not_verified, not failed', phpOnly.status === 'not_verified', phpOnly.status);
check('…reported with the repo\u2019s "not verified" code, never 0', phpOnly.code === 2, String(phpOnly.code));
check('…and it carries the reason, so the operator is told what went unread',
  /none of them JS\/TS/.test(phpOnly.coverage?.text || ''), phpOnly.coverage?.text);

const jsClean = coverageVerdict({ errors: [], codeFiles: 2, files: 5 });
check('a JS-bearing change with no errors still passes',
  jsClean.ok === true && jsClean.status === 'passed' && jsClean.code === 0, JSON.stringify(jsClean));
const jsBroken = coverageVerdict({ errors: [{ file: 'a.js', text: 'boom' }], codeFiles: 1, files: 1 });
check('a real parse error is failed, not not_verified',
  jsBroken.ok === false && jsBroken.status === 'failed' && jsBroken.code === 1, JSON.stringify(jsBroken));
check('coverage outranks an empty error list — that is the whole point',
  coverageVerdict({ errors: [], codeFiles: 0, files: 1 }).status === 'not_verified');

// ── the WordPress adapter consults it ───────────────────────────────────────
console.log('\n-- and the WordPress verifier reports it --');
const wpSrc = readFileSync(join(REPO, 'server/src/lib/delivery/wordpress.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
check('it imports the verdict', /import \{ coverageVerdict \} from '\.\.\/engine\/verificationCoverage\.js'/.test(wpSrc));
check('…and decides from the counts of the files it could actually read',
  /coverageVerdict\(\{ errors, codeFiles: scripts\.length, files: present\.length \}\)/.test(wpSrc));
// The shape this replaced — `ok: errors.length === 0` — is a clean bill of health
// over zero files. It must not survive anywhere in this adapter.
check('…never a bare "no errors means ok"', /ok: errors\.length === 0/.test(wpSrc) === false);
check('…and it still reports how many files it checked', /checkedFiles: scripts\.length/.test(wpSrc));

// ── and only a real failure blocks the ship ─────────────────────────────────
// A not_verified change is the normal case for this target. Blocking it would
// stop real work, which is how a gate ends up being switched off.
console.log('\n-- and only a real failure blocks the ship --');
const deploySrc = readFileSync(join(REPO, 'server/src/functions/wordPressDeploy.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
check('the ship gate blocks on failed', /verify\.status === 'failed' && !forceAllowed\(/.test(deploySrc));
check('…and no longer blocks on !ok, which not_verified also satisfies',
  /!verify\.ok && !forceAllowed\(/.test(deploySrc) === false);

// ── the UI is where the lie was READ ────────────────────────────────────────
// "0 script files clean" was a pass rendered from a check that examined nothing.
console.log('\n-- and the Deploy tab renders all three states --');
const tab = readFileSync(join(REPO, 'src/components/matrix/website/DeployTab.jsx'), 'utf8');
check('the Deploy tab handles failed explicitly', /verify\.status === 'failed'/.test(tab));
check('…and not_verified as its own state, not as clean', /verify\.status === 'not_verified'/.test(tab));
check('…showing why nothing was read', /verify\.coverage\?\.text/.test(tab));

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) {
  console.log('\nA verifier that examined nothing has verified nothing. Do not let it say ok.\n');
  process.exit(1);
}
console.log('the verifier reports what it did not look at.\n');
