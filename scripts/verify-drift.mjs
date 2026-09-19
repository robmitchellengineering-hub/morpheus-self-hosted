// Runtime verification for the H9 drift guard.
//
// Exercises evaluateDrift() against real value shapes rather than asserting a
// syntax check. Run:  node scripts/verify-drift.mjs
//
// Case 10 is the actual H9 incident replay: a workspace one commit behind main
// with ~45 deletions must be refused.

import { evaluateDrift, isMissingSyncedCommitColumn, MAX_UNSCOPED_DELETIONS } from '../server/src/lib/selfDevDrift.js';

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

console.log('\n8. explicit operator override');
check('allowed', reasonOf(evaluateDrift({ syncedCommit: OLDER, remoteHead: MAIN, deleteCount: 900, directToMain: true })), null);

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
check('offers the override', /force/.test(h9.message), true);
check('shows both SHAs', h9.message.includes(OLDER.slice(0, 7)) && h9.message.includes(MAIN.slice(0, 7)), true);

console.log('\n11. missing-column detection degrades safely');
check('Prisma P2022', isMissingSyncedCommitColumn({ code: 'P2022' }), true);
check('postgres wording',
  isMissingSyncedCommitColumn({ message: 'column "projects.synced_commit" does not exist' }), true);
check('unrelated error is not swallowed',
  isMissingSyncedCommitColumn({ message: 'connection terminated unexpectedly' }), false);
check('null is not swallowed', isMissingSyncedCommitColumn(null), false);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED\n`);
  process.exit(1);
}
console.log('all good\n');
