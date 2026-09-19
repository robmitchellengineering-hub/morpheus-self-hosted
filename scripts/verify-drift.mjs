// Runtime verification for the H9 drift guard.
//
// Exercises evaluateDrift() against real value shapes rather than asserting a
// syntax check. Run:  node scripts/verify-drift.mjs
//
// Case 10 is the actual H9 incident replay: a workspace one commit behind main
// with ~45 deletions must be refused.

import { evaluateDrift, isMissingSyncedCommitColumn, MAX_UNSCOPED_DELETIONS, readSyncedCommitSafely, recordSyncedCommitSafely } from '../server/src/lib/selfDevDrift.js';

const MAIN = 'a05aec8c40df45c71c4f01635633f125103c3f5d';
const OLDER = 'e0b2534d1a2b3c4d5e6f708192a3b4c5d6e7f809';

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

const reasonOf = (r) => (r === null ? null : r.reason);

console.log('\nH9 drift guard — runtime verification\n');

console.log('1. fresh mirror, no deletions');
check('allowed', reasonOf(evaluateDrift({ syncedCommit: MAIN, remoteHead: MAIN, deleteCount: 0 })), null);

console.log('\n2. stale mirror — one commit behind');
check('blocked as stale-workspace',
  reasonOf(evaluateDrift({ syncedCommit: OLDER, remoteHead: MAIN, deleteCount: 0 })), 'stale-workspace');

console.log('\n3. fresh mirror, ordinary small edit');
check('allowed', reasonOf(evaluateDrift({ syncedCommit: MAIN, remoteHead: MAIN, deleteCount: 2 })), null);

console.log('\n4. stale mirror but policy-scoped push');
check('allowed — scoped pushes cannot delete outside their allow-list',
  reasonOf(evaluateDrift({ syncedCommit: OLDER, remoteHead: MAIN, deleteCount: 0, scoped: true })), null);

console.log('\n5. fresh mirror, but 12 deletions');
check('blocked as excess-deletions',
  reasonOf(evaluateDrift({ syncedCommit: MAIN, remoteHead: MAIN, deleteCount: 12 })), 'excess-deletions');

console.log('\n6. unknown sync point (pre-migration), H9-scale deletions');
check('blocked as excess-deletions',
  reasonOf(evaluateDrift({ syncedCommit: null, remoteHead: MAIN, deleteCount: 45 })), 'excess-deletions');

console.log('\n7. unknown sync point, no deletions');
check('allowed — nothing to delete, so nothing to lose',
  reasonOf(evaluateDrift({ syncedCommit: null, remoteHead: MAIN, deleteCount: 0 })), null);

console.log('\n8. explicit override — and the routing flag must NOT be one');
check('acknowledgeDrift allows a stale, mass-deleting push',
  reasonOf(evaluateDrift({ syncedCommit: OLDER, remoteHead: MAIN, deleteCount: 900, acknowledgeDrift: true })), null);

// Regression, and the reason this section exists: the guard originally skipped
// itself on `directToMain`, which is a ROUTING decision and says nothing about
// staleness. That left the direct-to-main path — the one incident H9 actually
// took, and the only one with no PR, no review and no deploy preview in front of
// production — as the single path the guard did not protect.
check('directToMain alone does NOT bypass staleness',
  reasonOf(evaluateDrift({ syncedCommit: OLDER, remoteHead: MAIN, deleteCount: 0, directToMain: true })), 'stale-workspace');
check('directToMain alone does NOT bypass mass deletion',
  reasonOf(evaluateDrift({ syncedCommit: MAIN, remoteHead: MAIN, deleteCount: 900, directToMain: true })), 'excess-deletions');
check('H9 exactly, via directToMain -> still blocked',
  reasonOf(evaluateDrift({ syncedCommit: OLDER, remoteHead: MAIN, deleteCount: 45, directToMain: true })), 'stale-workspace');
check('force alone does NOT bypass either (force != acknowledgeDrift)',
  reasonOf(evaluateDrift({ syncedCommit: OLDER, remoteHead: MAIN, deleteCount: 45, force: true })), 'stale-workspace');
check('the message names the real override, not `force`',
  /acknowledgeDrift/.test(evaluateDrift({ syncedCommit: OLDER, remoteHead: MAIN, deleteCount: 0 }).message), true);

console.log('\n9. threshold boundary');
check(`exactly ${MAX_UNSCOPED_DELETIONS} allowed`,
  reasonOf(evaluateDrift({ syncedCommit: MAIN, remoteHead: MAIN, deleteCount: MAX_UNSCOPED_DELETIONS })), null);
check(`${MAX_UNSCOPED_DELETIONS + 1} blocked`,
  reasonOf(evaluateDrift({ syncedCommit: MAIN, remoteHead: MAIN, deleteCount: MAX_UNSCOPED_DELETIONS + 1 })), 'excess-deletions');

console.log('\n10. H9 REPLAY — stale workspace, ~45 files, blockWidget deleted');
const h9 = evaluateDrift({ syncedCommit: OLDER, remoteHead: MAIN, deleteCount: 45 });
check('blocked', reasonOf(h9), 'stale-workspace');
check('names the incident', /H9/.test(h9.message), true);
check('tells the operator to resync', /SYNC FROM GITHUB/.test(h9.message), true);
check('offers the override', /acknowledgeDrift/.test(h9.message), true);
check('shows both SHAs', h9.message.includes(OLDER.slice(0, 7)) && h9.message.includes(MAIN.slice(0, 7)), true);

console.log('\n11. classification helper (logging only — no longer gates control flow)');
check('Prisma P2022', isMissingSyncedCommitColumn({ code: 'P2022' }), true);
check('postgres wording',
  isMissingSyncedCommitColumn({ message: 'column "projects.synced_commit" does not exist' }), true);
check('unrelated error is not classified',
  isMissingSyncedCommitColumn({ message: 'connection terminated unexpectedly' }), false);
check('null is not classified', isMissingSyncedCommitColumn(null), false);

console.log('\n12. FAIL-OPEN CONTRACTS — the guard must never be why a push breaks');
// The regression this exists to prevent: the guard used to rethrow any error it
// did not recognise, so one unfamiliar driver error would make self-dev unable
// to push at all on an unmigrated deployment.
const weird = Object.assign(new Error('some unfamiliar driver failure'), { code: 'ZZ999' });

let seenReadErr = null;
check('read: unrecognised error -> null, not a throw',
  await readSyncedCommitSafely(async () => { throw weird; }, { onError: (e) => { seenReadErr = e; } }), null);
check('read: reported the error to onError', seenReadErr === weird, true);

check('read: null lookup -> null', await readSyncedCommitSafely(async () => null), null);
check('read: undefined lookup -> null', await readSyncedCommitSafely(async () => undefined), null);
check('read: empty string -> null (treated as unknown)', await readSyncedCommitSafely(async () => ''), null);
check('read: real SHA passes through', await readSyncedCommitSafely(async () => MAIN), MAIN);
check('read: connection loss -> null',
  await readSyncedCommitSafely(async () => { throw new Error('connection terminated unexpectedly'); }), null);

let seenWriteErr = null, seenContext = null;
check('record: unrecognised error -> false, not a throw',
  await recordSyncedCommitSafely(async () => { throw weird; },
    { context: 'mergeSelfDevPr', onError: (e, c) => { seenWriteErr = e; seenContext = c; } }), false);
check('record: reported the error and its context', seenWriteErr === weird && seenContext === 'mergeSelfDevPr', true);
check('record: success -> true', await recordSyncedCommitSafely(async () => 'ok'), true);
check('record: column-missing error is also swallowed (pre-migration)',
  await recordSyncedCommitSafely(async () => { throw Object.assign(new Error('column does not exist'), { code: 'P2022' }); }), false);

console.log('\n13. the H9 shape is blocked even with NO recorded sync point');
// This is why the guard is worth shipping before the migration: H9's signature
// is ~45 deletions, and the deletion-shape half needs no schema change.
check('45 deletions, sync point unknown -> blocked',
  reasonOf(evaluateDrift({ syncedCommit: null, remoteHead: MAIN, deleteCount: 45 })), 'excess-deletions');
check('11 deletions, sync point unknown -> blocked',
  reasonOf(evaluateDrift({ syncedCommit: null, remoteHead: MAIN, deleteCount: 11 })), 'excess-deletions');
check('a small delete, sync point unknown -> allowed (residual risk, needs the migration)',
  reasonOf(evaluateDrift({ syncedCommit: null, remoteHead: MAIN, deleteCount: 2 })), null);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED\n`);
  process.exit(1);
}
console.log('all good\n');
