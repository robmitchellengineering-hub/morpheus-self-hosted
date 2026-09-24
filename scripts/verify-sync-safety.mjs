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
import { assessLocalLoss, shouldRefuseSync, syncRefusalMessage } from '../server/src/lib/selfDevSyncSafety.js';
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
  }).atRisk, 0);
check('already current',
  assessLocalLoss({
    local: [{ path: 'a.js', content: NEW }],
    remote: [{ path: 'a.js', sha: sha(NEW) }],
    syncedShaByPath: new Map([['a.js', sha(NEW)]]),
  }).atRisk, 0);
check('an empty workspace is trivially safe', assessLocalLoss({ local: [], remote: [] }).atRisk, 0);

// ── 2. The demonstrated loss ────────────────────────────────────────────────
console.log('\n2. the two things that were destroyed are now caught');
const edited = assessLocalLoss({
  local: [{ path: 'cards.js', content: EDITED }],
  remote: [{ path: 'cards.js', sha: sha(NEW) }],
  syncedShaByPath: new Map([['cards.js', sha(OLD)]]),
});
check('an edited file is flagged as modified', edited.modified, ['cards.js']);
check('and counts as at risk', edited.atRisk, 1);

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
  }).atRisk, 0);
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
  }).atRisk, 0);
check('unknown provenance + absent upstream IS protected',
  assessLocalLoss({ local: [{ path: 'new.js', content: 'x' }], remote: [], syncedShaByPath: new Map() }).orphaned, ['new.js']);
check('no provenance map at all still protects a new file',
  assessLocalLoss({ local: [{ path: 'new.js', content: 'x' }], remote: [] }).orphaned, ['new.js']);

// ── 5. The decision ─────────────────────────────────────────────────────────
console.log('\n5. a refusal names what is at stake, and one flag is the only way past');
check('nothing at risk does not refuse', shouldRefuseSync({ assessment: { atRisk: 0 } }), false);
check('something at risk refuses', shouldRefuseSync({ assessment: { atRisk: 1 } }), true);
check('an explicit acknowledgement is the way through', shouldRefuseSync({ assessment: { atRisk: 3 }, acceptLocalLoss: true }), false);
check('a missing assessment does not refuse (fails open on its own bug)',
  shouldRefuseSync({}), false);
const message = syncRefusalMessage({ modified: ['cards.js'], orphaned: ['new.jsx'], atRisk: 2 });
check('the message names the edited file', message.includes('cards.js'), true);
check('the message names the new file', message.includes('new.jsx'), true);
check('the message says how to proceed deliberately', /acceptLocalLoss/.test(message), true);
check('the message does not pretend to advise a sync', /SYNC FROM GITHUB/i.test(message), false);

// ── 6. It is wired in before anything is written ────────────────────────────
console.log('\n6. the sync checks before it writes');
const sync = read('server/src/functions/importSelfDevRepo.js');
const assessIdx = sync.indexOf('assessLocalLoss(');
const firstWriteIdx = sync.indexOf('prisma.projectFile.upsert');
const deleteIdx = sync.indexOf('prisma.projectFile.deleteMany');
check('the sync assesses the risk', assessIdx > -1, true);
check('before the first upsert', assessIdx < firstWriteIdx, true);
check('before the deletions', assessIdx < deleteIdx, true);
check('it refuses with a 409', /status: 409/.test(sync), true);
check('the refusal carries a machine-readable code', sync.includes("code: 'SYNC_WOULD_LOSE_LOCAL_WORK'"), true);
check('the only way past is an explicit flag', /acceptLocalLoss: body\?\.acceptLocalLoss === true/.test(sync), true);
check('it records provenance after the sync', sync.includes('recordProvenance(project.id'), true);

// The same function used to drop a file whose blob fetch failed — the local row
// fell out of `ok` and was deleted as "no longer upstream".
check('a failed blob fetch is no longer treated as an upstream deletion', /keepPaths = new Set\(\[\.\.\.ok\.map\(\(f\) => f\.path\), \.\.\.failedPaths\]\)/.test(sync), true);

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
