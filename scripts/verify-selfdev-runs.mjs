// Verification for the self-dev run record — the durable trace of what a run did.
//
// Two halves again:
//
//   1. BEHAVIOUR of the pure rules in server/src/lib/selfDevRuns.js: which
//      stages are recorded, how an HTTP status becomes a stage status, what is
//      kept out of a handler's result, and that a detail note cannot grow
//      without bound.
//   2. STRUCTURE of the pieces that have to stay honest: the DDL must be
//      additive and idempotent (it ships ahead of an applier that has never
//      run), the dispatcher must record in a `finally` so a throwing stage still
//      leaves a row, and the recording must never be able to fail a request.
//
// Run: node scripts/verify-selfdev-runs.mjs

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SELF_DEV_STAGES, MAX_DETAIL_CHARS, newRunId, isMissingRunsTable,
  statusForHttp, clampDetail, summariseResult,
} from '../server/src/lib/selfDevRunRules.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const read = (rel) => readFileSync(path.join(REPO, rel), 'utf8');

let failures = 0;
let checks = 0;

function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`);
    failures++;
  }
}

console.log('\nself-dev run record — verification\n');

// ── 1. What gets recorded ───────────────────────────────────────────────────
console.log('1. exactly the pipeline is recorded, and nothing else');
check('the pipeline stages are mapped', Object.keys(SELF_DEV_STAGES).sort(), [
  'applySelfDevMigrations', 'chatWithMorpheus', 'importSelfDevRepo', 'mergeSelfDevPr',
  'pushSelfDevToGithub', 'revertSelfDevPush', 'smokeCheckSelfDev', 'verifySelfDev',
]);
check('stage names are unique', new Set(Object.values(SELF_DEV_STAGES)).size, Object.keys(SELF_DEV_STAGES).length);
check('a non-pipeline function is not a stage', SELF_DEV_STAGES.browseTemplates, undefined);
check('a run id is a uuid', /^[0-9a-f-]{36}$/.test(newRunId()), true);
check('run ids differ', newRunId() === newRunId(), false);

// ── 2. How a stage ends ─────────────────────────────────────────────────────
console.log('\n2. a refusal is not a failure');
check('200 is ok', statusForHttp(200), 'ok');
check('302 is ok', statusForHttp(302), 'ok');
check('400 is blocked (the guard working, not breaking)', statusForHttp(400), 'blocked');
check('403 is blocked', statusForHttp(403), 'blocked');
check('429 (daily cap) is blocked', statusForHttp(429), 'blocked');
check('500 is failed', statusForHttp(500), 'failed');
check('no status at all is failed, never ok', statusForHttp(undefined), 'failed');
check('0 is failed', statusForHttp(0), 'failed');

// ── 3. What is kept ─────────────────────────────────────────────────────────
console.log('\n3. a detail note is a note, not a copy of the workspace');
check('a short note is untouched', clampDetail('ok'), 'ok');
check('an object becomes json', clampDetail({ a: 1 }), '{"a":1}');
check('null becomes empty', clampDetail(null), '');
check('a long note is truncated', clampDetail('x'.repeat(MAX_DETAIL_CHARS + 50)).length, MAX_DETAIL_CHARS + 1);
check('truncation is marked', clampDetail('x'.repeat(MAX_DETAIL_CHARS + 1)).endsWith('…'), true);

const pushResult = {
  mode: 'pr', prNumber: 191, commitSha: 'abc123', createCount: 1, updateCount: 2, deleteCount: 0,
  fileOperations: [{ path: 'a.js', content: 'x'.repeat(5000) }],
  errors: [{ file: 'a.js', text: 'noise' }],
};
const kept = JSON.parse(summariseResult(pushResult));
check('the useful fields survive', [kept.mode, kept.prNumber, kept.commitSha], ['pr', 191, 'abc123']);
check('the file bodies are dropped', kept.fileOperations, undefined);
check('the error array is dropped', kept.errors, undefined);
check('an oversized array is capped', JSON.parse(summariseResult({ deletePaths: Array.from({ length: 40 }, (_, i) => `f${i}.js`) })).deletePaths.length, 8);
check('nulls are omitted rather than stored', summariseResult({ ok: true, prNumber: null }), '{"ok":true}');
check('a non-object result is empty', summariseResult('done'), '');
check('an array result is empty', summariseResult([1, 2]), '');
check('a missing column is detectable', isMissingRunsTable({ code: 'P2021' }), true);
check('a missing relation is detectable', isMissingRunsTable({ message: 'relation "self_dev_runs" does not exist' }), true);
check('some other error is not that', isMissingRunsTable({ message: 'connection refused' }), false);

// ── 4. The DDL is safe to ship ahead of its applier ─────────────────────────
console.log('\n4. the migration is additive, idempotent, and non-destructive');
const SQL_PATH = 'server/prisma/selfdev-add-selfdev-runs.sql';
check('the migration file exists', existsSync(path.join(REPO, SQL_PATH)), true);
const sql = read(SQL_PATH).toLowerCase();
check('it creates a table if not exists', /create table if not exists/.test(sql), true);
check('it creates indexes if not exists', /create index if not exists/.test(sql), true);
check('it drops nothing', /\bdrop\b/.test(sql), false);
check('it deletes nothing', /\bdelete\b/.test(sql), false);
check('it alters no existing column', /alter table/.test(sql), false);
check('it names the table the code uses', /self_dev_runs/.test(sql) && read('server/src/lib/selfDevRuns.js').includes('self_dev_runs'), true);
check('it stores an owner, so reads can be scoped', /created_by_id/.test(sql), true);

// ── 5. The dispatcher records, and cannot be broken by recording ────────────
console.log('\n5. the dispatcher records every pipeline stage');
const route = read('server/src/routes/functions.routes.js');
const runFn = route.slice(route.indexOf('async function runFunction'));
check('it asks the registry whether this function is a stage', runFn.includes('SELF_DEV_STAGES[name]'), true);
check('it records', runFn.includes('recordStage({'), true);
check('the status comes from the real HTTP status', runFn.includes('statusForHttp(res.statusCode)'), true);
check('the duration is measured', runFn.includes('Date.now() - startedAt'), true);
// The `finally` is the whole point: a stage that throws still leaves a row.
const finallyIdx = runFn.indexOf('} finally {');
const recordIdx = runFn.indexOf('recordStage({');
check('recording happens in a finally, so a throw is still recorded', finallyIdx > -1 && recordIdx > finallyIdx, true);
check('recording is awaited so the row exists when the caller has its answer', /await recordStage\(/.test(runFn), true);
// The module this depends on must never throw into a request.
const lib = read('server/src/lib/selfDevRuns.js');
check('the recorder swallows its own errors', /catch \(err\) \{[\s\S]{0,400}return false;/.test(lib), true);
check('reads are owner-scoped', lib.includes('created_by_id = $1'), true);

// ── 6. It can be read back without a database client ────────────────────────
console.log('\n6. the record is readable through the API');
check('a read-back function exists', existsSync(path.join(REPO, 'server/src/functions/getSelfDevRuns.js')), true);
check('it is on the operator allow-list', read('server/src/lib/operatorToken.js').includes("'getSelfDevRuns'"), true);
const cli = read('scripts/morpheus.mjs');
check('the CLI has a runs command', /case 'runs':/.test(cli), true);
check('the CLI can start a fresh run', /case 'newrun':/.test(cli), true);
check('every call carries a run id, so stages group', /\.\.\.body, runId: currentRunId\(\)/.test(cli), true);
check('the run id is kept out of git', read('.gitignore').includes('.morpheus-run'), true);

console.log(`\n${failures === 0 ? '✓' : '✗'} ${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
