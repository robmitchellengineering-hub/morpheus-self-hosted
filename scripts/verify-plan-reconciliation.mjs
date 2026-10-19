// Does "missing" mean missing?
//
// WHY THIS EXISTS (defect 9, measured on the first real end-to-end backend run, 2026-09-30). The run
// reported `incomplete: true` with four "missing" files. The plan asked for
// `backend/migrations/001_initial.sql`; the generator wrote `backend/migrations/0001_init.sql`. The check was
// `planned.filter(p => !written.has(p))` — a literal set difference — so a file that EXISTS was reported
// absent. Three of the four were genuine gaps; one was a lie, and **a false "missing" is worse than none**,
// because it teaches the operator to ignore the flag.
//
// The opposite error is worse still: a reconciliation eager enough to hide a real gap. So the two halves
// asserted here are "a renamed file is not missing" AND "two candidates are never guessed between", and
// every case is decided by calling the function rather than by reading it.
//
// Run:  node scripts/verify-plan-reconciliation.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcilePlannedFiles, reconciliationNote } from '../server/src/lib/planReconciliation.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}
const missingOf = (p, w) => reconcilePlannedFiles(p, w).missing;
const howsOf = (p, w) => reconcilePlannedFiles(p, w).substituted.map((s) => `${s.planned}>${s.actual}:${s.how}`);

console.log('\n1. the case that produced this file');
// The exact six planned paths and three written paths from the real run.
const PLANNED = [
  'backend/package.json', 'backend/index.js', 'backend/migrations/001_initial.sql',
  'backend/public/app.js', 'backend/public/style.css', 'backend/uploads/.gitkeep',
];
const WRITTEN = ['package.json', 'index.js', 'migrations/0001_init.sql'];
check('the renamed migration is NOT reported missing',
  missingOf(PLANNED, WRITTEN).includes('backend/migrations/001_initial.sql'), false);
check('…it is reported as a substitution, naming both paths',
  howsOf(PLANNED, WRITTEN), ['backend/migrations/001_initial.sql>backend/migrations/0001_init.sql:renamed']);
check('…and the three GENUINE gaps are still missing, which is the point of the flag',
  missingOf(PLANNED, WRITTEN), ['backend/public/app.js', 'backend/public/style.css', 'backend/uploads/.gitkeep']);
// This is the half that must not regress: an eager reconciliation would call all six fine.
check('the run is still incomplete, because three files really are absent',
  reconcilePlannedFiles(PLANNED, WRITTEN).missing.length > 0, true);

console.log('\n2. it never guesses between candidates');
// Two planned migrations and one written file: which one was satisfied? Unknowable, so neither is claimed.
check('two unmatched planned files in a directory means no substitution',
  missingOf(['migrations/001_a.sql', 'migrations/002_b.sql'], ['migrations/003_c.sql']),
  ['backend/migrations/001_a.sql', 'backend/migrations/002_b.sql']);
check('…and two written candidates means no substitution either',
  missingOf(['migrations/001_a.sql'], ['migrations/002_b.sql', 'migrations/003_c.sql']),
  ['backend/migrations/001_a.sql']);
check('one planned file cannot satisfy two entries of the plan',
  missingOf(['a/x.sql', 'b/x.sql'], ['a/x.sql']), ['backend/b/x.sql']);
check('a different extension is not a rename',
  missingOf(['migrations/001_init.sql'], ['migrations/001_init.txt']), ['backend/migrations/001_init.sql']);
// With no extension to anchor on, "one file in this directory" is not evidence that they are the same file.
check('an extensionless file is never matched by rename',
  missingOf(['Dockerfile'], ['run.sh']), ['backend/Dockerfile']);

console.log('\n3. the ordinary cases still behave');
check('an exact path is satisfied and not reported',
  missingOf(['server/db.js'], ['server/db.js']), []);
check('a file that moved keeps its name and is reported as moved, not missing',
  howsOf(['server/routes/tasks.js'], ['src/routes/tasks.js']), ['backend/server/routes/tasks.js>backend/src/routes/tasks.js:moved']);
check('the backend/ prefix does not matter on either side',
  missingOf(['backend/index.js'], ['index.js']), []);
check('…nor does it on the plan side alone',
  missingOf(['index.js'], ['backend/index.js']), []);
check('an empty plan is complete, not incomplete',
  missingOf([], []), []);
check('a plan with nothing written is all missing',
  missingOf(['a.js', 'b.js'], []), ['backend/a.js', 'backend/b.js']);
check('a perfect build substitutes nothing', howsOf(PLANNED, PLANNED), []);
check('duplicates on either side do not double-count',
  missingOf(['a.js', 'a.js'], ['a.js']), []);

console.log('\n4. the operator-facing sentence');
// `summary` is what BackendPanel logs, so this sentence is the only part of the reconciliation a person
// actually sees. It must name the gaps and the rename, and stay silent when there is nothing to say.
const note = reconciliationNote(reconcilePlannedFiles(PLANNED, WRITTEN));
check('the note counts what was written against what was planned',
  /^3 of 6 planned file\(s\) written\./.test(note), true);
check('…names every genuine gap', ['public/app.js', 'public/style.css', 'uploads/.gitkeep'].every((f) => note.includes(f)), true);
check('…and explains the rename rather than hiding it',
  note.includes("the plan's backend/migrations/001_initial.sql was written as backend/migrations/0001_init.sql"), true);
check('a clean build says nothing at all — a log nobody needs is noise',
  reconciliationNote(reconcilePlannedFiles(PLANNED, PLANNED)), null);
check('a missing-only build still leads with the count',
  /^0 of 1 planned file\(s\) written\./.test(reconciliationNote({ satisfied: [], substituted: [], missing: ['x.js'] })), true);
check('junk does not crash it',
  Array.isArray(reconcilePlannedFiles(undefined, null).missing) && reconciliationNote(undefined) === null, true);

console.log('\n5. the caller uses it, and uses it for what it DISPLAYS');
// The reconciliation only matters if the result reflects it. Asserted on comment-stripped source, because a
// guard satisfied by the comment explaining the fix is this repo's most-repeated mistake (H19).
const gen = readFileSync(join(ROOT, 'server/src/functions/generateBackend.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
check('generateBackend reconciles the plan against what was written', /reconcilePlannedFiles\(plannedFiles/.test(gen), true);
check('…the summary carries the note, which is the line the operator sees',
  /summary: planNote \?/.test(gen), true);
check('…incomplete means genuinely absent', /incomplete: recon\.missing\.length > 0/.test(gen), true);
// The literal set difference is the defect itself; if it comes back, so does the false "missing".
check('…and the literal set-difference check is gone',
  /plannedFiles\.map\(normalizeBackendPath\)\.filter/.test(gen), false);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ a present file can be reported missing, or a real gap can be hidden\n');
  process.exit(1);
}
console.log('"missing" now means genuinely absent, and a rename is reported instead of blamed\n');
