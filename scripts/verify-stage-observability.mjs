// Verification that a self-dev turn reports its own memory.
//
// WHY THIS IS A GUARD AND NOT JUST A LOG LINE
//
// On 2026-09-24 a self-dev chat turn took the production container down with no
// error anywhere: the last log entry was a routine balance check, then the
// container entrypoint ran again. That is an OOM kill seen from inside the
// process — the kernel never lets it speak — and Northflank reported the deploy
// as COMPLETED the whole time. The pipeline had never reported its own memory,
// so "where did the peak come from" was unanswerable.
//
// The lines that fix that are three console.log calls, which is exactly the kind
// of change that gets tidied away later by someone who cannot see why it is
// there. So the checks below pin the two things that make the instrument work:
//
//   1. it reports MEMORY at each stage boundary and around the bundle, and
//   2. it writes to STDOUT, not to the response stream — a reading sent to the
//      client dies with the request, and the whole point is that it survives a
//      process that is about to be killed.
//
// Run: node scripts/verify-stage-observability.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const CHAT = 'server/src/functions/chatWithMorpheus.js';
const src = readFileSync(path.join(REPO, CHAT), 'utf8');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

console.log('\nstage observability — verification\n');

// ── 1. The reading exists and is in real units ──────────────────────────────
console.log('1. the pipeline reports its own memory');
check('a memory helper exists', /function memMb\(\)/.test(src), true);
check('it reads resident memory', /process\.memoryUsage\(\)\.rss/.test(src), true);
check('it converts bytes to MB', /\/\s*1024\s*\/\s*1024/.test(src), true);
check('the log lines carry the unit, so a reader is not guessing', /rss=\$\{memMb\(\)\}MB/.test(src), true);
check('the helper is documented with the incident that caused it', /OOM kill looks like from inside|OOM/i.test(src), true);

// ── 2. Every stage boundary reports it ──────────────────────────────────────
console.log('\n2. every stage boundary reports it');
const emitter = src.slice(src.indexOf('function makeStageEmitter'), src.indexOf('function makeStageEmitter') + 1800);
check('stage start reports memory', /console\.log\(`\[chatWithMorpheus\] stage start: \$\{stage\} rss=\$\{memMb\(\)\}MB/.test(emitter), true);
check('stage done reports memory', /stage done: \$\{stage\}[\s\S]{0,120}rss=\$\{memMb\(\)\}MB/.test(emitter), true);

// ── 3. The heaviest step gets its own reading ───────────────────────────────
console.log('\n3. the bundle — the heaviest single step — is bracketed');
const verifyIdx = src.indexOf('deep-verify: ${fullFiles.length}');
check('memory is logged before bundling', verifyIdx > -1, true);
check('memory is logged after bundling', /deep-verify: done[\s\S]{0,160}rss=\$\{memMb\(\)\}MB[\s\S]{0,40}after bundling/.test(src), true);
check('the reading names how many files are held', /\$\{fullFiles\.length\} file\(s\) in memory/.test(src), true);
// This pinned `let deep = await adapter.verify(` as a literal, and that line was split when the first
// deep verify was made fail-safe: the verification can now THROW (a full or unwritable disk in
// verifyProject's temp directory) and recording it as critical rather than letting it discard the turn
// is the whole point of that change. So the check now matches the FIRST verify call wherever it sits,
// which is what "the reading comes before it" actually means — a literal spelling of the line was
// testing the wrong thing.
const firstVerifyCall = src.search(/deep\s*=\s*await adapter\.verify\(/);
check('the before-reading comes before the verify call', firstVerifyCall > -1 && verifyIdx < firstVerifyCall, true);

// ── 4. It survives the process being killed ─────────────────────────────────
console.log('\n4. the readings go somewhere that outlives the request');
const memLines = src.split('\n').filter((l) => l.includes('rss=${memMb()}'));
check('there is at least one such line', memLines.length > 0, true);
check('every one of them writes to stdout', memLines.every((l) => l.includes('console.log')), true);
check('none of them goes to the response stream', memLines.some((l) => l.includes('emit(')), false);

// ── 5. Rework is attributed to the gate that demanded it ────────────────────
console.log('\n5. rework is attributed to a gate, not just counted');
const reviewer = readFileSync(path.join(REPO, 'server/src/lib/reviewer.js'), 'utf8');
check('the reviewer counts its fix passes', /let coderFixAttempts = 0;/.test(reviewer), true);
check('and increments them inside the retry loop', reviewer.indexOf('coderFixAttempts++;') > reviewer.indexOf('attempt < MAX_REVIEW_ATTEMPTS'), true);
check('it reports them to the caller', /attempts: coderFixAttempts,/.test(reviewer), true);
check('and whether the first review found anything critical', /criticalFound: firstReviewHadCritical,/.test(reviewer), true);

check('the syntax gate counts its fix passes', /let syntaxFixAttempts = 0;/.test(src), true);
check('the bundle gate counts its fix passes', /let bundleFixAttempts = 0;/.test(src), true);
// The convention gate runs in the same fix loop as the bundle pass but is counted
// apart from it — a house-rule violation is not a failure to bundle, and folding
// them together would make the run record describe the wrong problem.
check('the convention gate counts its fix passes', /let conventionFixAttempts = 0;/.test(src), true);
// Positionally, because a counter incremented OUTSIDE its loop reads zero for
// ever and would look exactly like "this gate never fires".
const syntaxLoop = src.indexOf('for (let attempt = 1; syntaxErrors.length > 0');
const bundleLoop = src.indexOf('for (let attempt = 1; !deep.ok');
check('the syntax count is incremented inside its own loop',
  src.indexOf('syntaxFixAttempts++;') > syntaxLoop && src.indexOf('syntaxFixAttempts++;') < bundleLoop, true);
check('the bundle count is incremented inside its own loop',
  src.indexOf('bundleFixAttempts++;') > bundleLoop, true);
check('the convention count is incremented inside the same loop, not before it',
  src.indexOf('conventionFixAttempts++;') > bundleLoop, true);

// The point of the exercise: it must reach the RESULT, which is what the
// dispatcher records — a log line alone dies with the container.
// This used to pin one exact literal. That failed for the wrong reason when a gate
// was added (a formatting mismatch) and could miss a gate being dropped. The
// property that matters is that EVERY gate is named: a gate that reworks without
// reporting it is a rework nobody can see in the run record.
for (const gate of ['syntax', 'bundle', 'convention', 'reviewer']) {
  check(`the rework summary reports the ${gate} gate`,
    new RegExp(`rework: \\{[^}]*\\b${gate}: `).test(src), true);
}
check('the rework summary reaches the result event', src.indexOf('rework: { syntax:') > src.indexOf("emit({ type: 'result'"), true);
check('it is on the run-record allow-list, so it survives the session',
  readFileSync(path.join(REPO, 'server/src/lib/selfDevRunRules.js'), 'utf8').includes("'rework'"), true);
check('the rework reading also goes to stdout', /console\.log\(`\[chatWithMorpheus\] rework: syntax=\$\{syntaxFixAttempts\}/.test(src), true);

// ── 6. A STREAMING handler can still reach the run record ───────────────────
console.log('\n6. the streaming stage is not blank in the record');
const routes = readFileSync(path.join(REPO, 'server/src/routes/functions.routes.js'), 'utf8');
check('the chat turn publishes its detail out of band', /res\.locals\.morpheusStageDetail = \{ rework:/.test(src), true);
check('the dispatcher reads it', /res\.locals\?\.morpheusStageDetail/.test(routes), true);
check('and only when no return value supplied one', /if \(!detail && res\.locals\?\.morpheusStageDetail\)/.test(routes), true);
check('the read happens before the stage is recorded',
  routes.indexOf('morpheusStageDetail') < routes.indexOf('await recordStage({'), true);

// ── 7. The CONTAINER's memory, which is what the kernel acts on ─────────────
console.log('\n7. the container reading, not just this process');
const { parseCgroupBytes, containerMemory, describeContainerMemory } = await import('../server/src/lib/containerMemory.js');
check('a byte count parses', parseCgroupBytes('268435456'), 268435456);
check('surrounding whitespace is tolerated', parseCgroupBytes(' 123456 \n'), 123456);
check('v2 "max" means no limit, not zero', parseCgroupBytes('max'), null);
check('v1 unlimited is not mistaken for a limit', parseCgroupBytes('9223372036854771712'), null);
// The sentinel above is already rejected as an unsafe integer, so it does NOT
// exercise the absurd-size rule. This does, which is the point: without it the
// rule was unreachable and a mutation removing it changed nothing.
check('an absurdly large limit is treated as no limit too', parseCgroupBytes('5000000000000'), null);
check('zero is not a limit', parseCgroupBytes('0'), null);
check('garbage is null, never NaN', parseCgroupBytes('abc'), null);
check('empty is null', parseCgroupBytes(''), null);
check('null is null', parseCgroupBytes(null), null);
check('a missing cgroup tree reads as unavailable, not as zero',
  containerMemory({ v2: '/definitely/not/here', v1: '/nor/here' }), null);
check('unavailable says so in the log token', describeContainerMemory(null), 'cgroup=unavailable');
check('usage alone is reported', describeContainerMemory({ usedBytes: 104857600, limitBytes: null }), 'cgroup=100MB');
check('usage against a limit is reported',
  describeContainerMemory({ usedBytes: 104857600, limitBytes: 536870912 }), 'cgroup=100/512MB');

// The reason the module exists: rss alone describes one process, and the step
// that kills the container runs in a child.
check('the module records why rss is not enough', /child, invisible to it|CHILD process whose footprint is invisible/i.test(readFileSync(path.join(REPO, 'server/src/lib/containerMemory.js'), 'utf8')), true);
const stageLines = src.split('\n').filter((l) => l.includes('rss=${memMb()}') && l.includes('console.log'));
check('every self-memory log line also carries the container reading',
  stageLines.length > 0 && stageLines.every((l) => l.includes('containerMb()')), true);

console.log(`\n${failures === 0 ? '✓' : '✗'} ${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
