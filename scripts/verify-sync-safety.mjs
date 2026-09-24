// Verification for sync safety — the rule that decides whether un-pushed work
// survives a SYNC FROM GITHUB.
//
// The bug it exists for was demonstrated, not theorised: the H9 drift guard
// refused a stale push, told the operator to SYNC and re-apply, and the sync
// deleted the new file and reverted the edited one. So these checks are about
// one property — a sync must never silently destroy work — plus the inverse
// property that keeps the fix usable: it must NOT refuse a normal catch-up, or
// the cure blocks the thing it is protecting.
//
// Run: node scripts/verify-sync-safety.mjs

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessLocalLoss, planSync, syncPreservedMessage } from '../server/src/lib/selfDevSyncSafety.js';
import { gitBlobSha } from '../server/src/lib/selfDevRepo.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const read = (rel) => readFileSync(path.join(REPO, rel), 'utf8');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

const sha = (s) => gitBlobSha(s);
const OLD = 'the file as upstream had it at the last sync';
const NEW = 'the file as upstream has it now';
const EDITED = 'the operator edited this and has not pushed';

console.log('\nsync safety — verification\n');

// ── 1. The normal case must still work ──────────────────────────────────────
console.log('1. a plain catch-up is not blocked');
check('upstream moved on, local copy untouched',
  assessLocalLoss({
    local: [{ path: 'a.js', content: OLD }],
    remote: [{ path: 'a.js', sha: sha(NEW) }],
    syncedShaByPath: new Map([['a.js', sha(OLD)]]),
  }).preserved, 0);
check('already current',
  assessLocalLoss({
    local: [{ path: 'a.js', content: NEW }],
    remote: [{ path: 'a.js', sha: sha(NEW) }],
    syncedShaByPath: new Map([['a.js', sha(NEW)]]),
  }).preserved, 0);
check('an empty workspace is trivially safe', assessLocalLoss({ local: [], remote: [] }).preserved, 0);

// ── 2. The demonstrated loss ────────────────────────────────────────────────
console.log('\n2. the two things that were destroyed are now caught');
const edited = assessLocalLoss({
  local: [{ path: 'cards.js', content: EDITED }],
  remote: [{ path: 'cards.js', sha: sha(OLD) }],   // upstream did NOT move
  syncedShaByPath: new Map([['cards.js', sha(OLD)]]),
});
check('an edited file is flagged as modified', edited.modified, ['cards.js']);
check('and counts as preserved work', edited.preserved, 1);
check('with no conflict, because upstream did not touch it', edited.conflicts, []);

// BOTH sides moved: the case the first design could not express, and the one
// that will overwrite upstream's version when the local copy is pushed.
const bothMoved = assessLocalLoss({
  local: [{ path: 'shared.js', content: EDITED }],
  remote: [{ path: 'shared.js', sha: sha(NEW) }],
  syncedShaByPath: new Map([['shared.js', sha(OLD)]]),
});
check('a file changed on both sides is a conflict, not a plain edit', bothMoved.conflicts, ['shared.js']);
check('and is not merely "modified"', bothMoved.modified, []);

const created = assessLocalLoss({
  local: [{ path: 'cards/selfdev_runs.jsx', content: 'a brand new card' }],
  remote: [],
  syncedShaByPath: new Map([['cards/selfdev_runs.jsx', null]]),
});
check('a file upstream has never seen is flagged as orphaned', created.orphaned, ['cards/selfdev_runs.jsx']);

// ── 3. Deletions that are genuinely upstream's doing still happen ───────────
console.log('\n3. an upstream deletion is not mistaken for local work');
check('a file upstream deleted, untouched here, is safe to drop',
  assessLocalLoss({
    local: [{ path: 'gone.js', content: OLD }],
    remote: [],
    syncedShaByPath: new Map([['gone.js', sha(OLD)]]),
  }).preserved, 0);
check('but one edited here before upstream deleted it is protected',
  assessLocalLoss({
    local: [{ path: 'gone.js', content: EDITED }],
    remote: [],
    syncedShaByPath: new Map([['gone.js', sha(OLD)]]),
  }).orphaned, ['gone.js']);

// ── 4. The deliberate asymmetry around unknown provenance ───────────────────
console.log('\n4. unknown provenance protects deletions but does not block catch-up');
check('unknown provenance + changed upstream is NOT treated as local work',
  assessLocalLoss({
    local: [{ path: 'a.js', content: OLD }],
    remote: [{ path: 'a.js', sha: sha(NEW) }],
    syncedShaByPath: new Map(),
  }).preserved, 0);
check('unknown provenance + absent upstream IS protected',
  assessLocalLoss({ local: [{ path: 'new.js', content: 'x' }], remote: [], syncedShaByPath: new Map() }).orphaned, ['new.js']);
check('no provenance map at all still protects a new file',
  assessLocalLoss({ local: [{ path: 'new.js', content: 'x' }], remote: [] }).orphaned, ['new.js']);

// ── 5. The sync keeps work rather than refusing ─────────────────────────────
console.log('\n5. the sync keeps work instead of refusing (the first version deadlocked)');
const editPlan = planSync({ assessment: { modified: ['cards.js'], conflicts: [], orphaned: [], deletions: [] } });
check('a local edit is not fetched over', editPlan.skipFetch, ['cards.js']);
check('nothing is discarded', editPlan.discarding, []);
check('and the plan says what it kept', editPlan.preserved.modified, ['cards.js']);

const conflictPlan = planSync({ assessment: { modified: [], conflicts: ['shared.js'], orphaned: [], deletions: [] } });
check('a conflict is preserved too', conflictPlan.skipFetch, ['shared.js']);
check('and reported as a conflict, not as an ordinary edit', conflictPlan.preserved.conflicts, ['shared.js']);

const orphanPlan = planSync({ assessment: { modified: [], conflicts: [], orphaned: ['new.jsx'], deletions: [] } });
check('a file that exists only here is not deleted', orphanPlan.skipDelete, ['new.jsx']);
check('and there is nothing upstream to fetch for it', orphanPlan.skipFetch, []);

const discardPlan = planSync({ assessment: { modified: ['a'], conflicts: ['b'], orphaned: ['c'], deletions: [] }, acceptLocalLoss: true });
check('the deliberate discard skips nothing', [discardPlan.skipFetch, discardPlan.skipDelete], [[], []]);
check('and names exactly what it destroys', discardPlan.discarding, ['a', 'b', 'c']);

check('a clean workspace plans no skips',
  planSync({ assessment: { modified: [], conflicts: [], orphaned: [], deletions: [] } }).skipFetch, []);
check('a missing assessment plans no skips', planSync({}).skipFetch, []);
check('a local edit does NOT block the rest of the sync',
  planSync({ assessment: { modified: ['cards.js'], conflicts: [], orphaned: [], deletions: [] } }).skipDelete, []);

const message = syncPreservedMessage({ modified: ['cards.js'], orphaned: ['new.jsx'], conflicts: ['shared.js'] });
check('the message names the kept edit', message.includes('cards.js'), true);
check('it names the new file', message.includes('new.jsx'), true);
check('it warns that a conflict will overwrite upstream on push', /CONFLICT/.test(message) && message.includes('shared.js'), true);
check('it does not tell the operator to sync again', /SYNC FROM GITHUB/i.test(message), false);
check('nothing preserved means nothing to say', syncPreservedMessage({ modified: [], orphaned: [], conflicts: [] }), '');

// ── 6. It is wired in before anything is written ────────────────────────────
console.log('\n6. the sync checks before it writes');
const sync = read('server/src/functions/importSelfDevRepo.js');
const assessIdx = sync.indexOf('assessLocalLoss(');
const firstWriteIdx = sync.indexOf('prisma.projectFile.upsert');
const deleteIdx = sync.indexOf('prisma.projectFile.deleteMany');
check('the sync assesses the risk', assessIdx > -1, true);
check('before the first upsert', assessIdx < firstWriteIdx, true);
check('before the deletions', assessIdx < deleteIdx, true);
check('the sync no longer refuses at all (that was the deadlock)', /status: 409/.test(sync), false);
check('it plans what to skip', sync.includes('planSync({ assessment: localLoss'), true);
check('a preserved path is never fetched over', sync.includes('!skipFetch.has(item.path)'), true);
check('a preserved orphan is never deleted', sync.includes('...skipDelete]'), true);
check('provenance is not recorded for a preserved path', sync.includes('&& !skipFetch.has(p)'), true);
check('the deliberate discard is still available', /acceptLocalLoss: body\?\.acceptLocalLoss === true/.test(sync), true);
check('the result reports what was kept', sync.includes('preserved: plan.preserved'), true);
check('it records provenance after the sync', sync.includes('recordProvenance(project.id'), true);

// The same function used to drop a file whose blob fetch failed — the local row
// fell out of `ok` and was deleted as "no longer upstream".
check('a failed blob fetch is no longer treated as an upstream deletion', sync.includes('...failedPaths, ...skipDelete]'), true);

// ── 7. Provenance is written on the paths that make local == upstream ───────
console.log('\n7. provenance is refreshed wherever local becomes upstream');
check('a direct push marks the workspace synced', read('server/src/functions/pushSelfDevToGithub.js').includes('markWorkspaceSynced(projectId)'), true);
check('a merge marks the workspace synced', read('server/src/functions/mergeSelfDevPr.js').includes('markWorkspaceSynced(project.id)'), true);
const push = read('server/src/functions/pushSelfDevToGithub.js');
check('the push only marks on the direct path', push.indexOf('markWorkspaceSynced(projectId)') > push.indexOf('if (directToMain'), true);

// ── 8. The column ships with its DDL, applied before the code needs it ──────
console.log('\n8. the migration is additive and matches the schema');
const SQL = 'server/prisma/selfdev-add-file-synced-sha.sql';
check('the migration exists', existsSync(path.join(REPO, SQL)), true);
const sql = read(SQL).toLowerCase();
// Comments are prose — this migration's own explanation says "safe to drop"
// while containing no DROP at all. Scan the statements, not the sentences.
const sqlCode = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
check('it alters the right table', /alter table project_files/.test(sqlCode), true);
check('it is idempotent', /add column if not exists/.test(sqlCode), true);
check('it drops nothing', /\bdrop\b/.test(sqlCode), false);
check('the schema declares the column', /synced_sha\s+String\?/.test(read('server/prisma/schema.prisma')), true);
check('the state module reads it by name', read('server/src/lib/selfDevSyncState.js').includes('synced_sha'), true);

console.log(`\n${failures === 0 ? '✓' : '✗'} ${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
