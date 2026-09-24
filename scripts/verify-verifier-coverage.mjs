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
import { coverageError } from '../server/src/lib/engine/verificationCoverage.js';

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

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) {
  console.log('\nA verifier that examined nothing has verified nothing. Do not let it say ok.\n');
  process.exit(1);
}
console.log('the verifier reports what it did not look at.\n');
