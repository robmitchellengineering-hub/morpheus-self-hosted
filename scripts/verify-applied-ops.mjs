// Does "changed" mean changed?
//
// WHY THIS EXISTS (defect 4, 2026-09-30). `appliedOps` is a MIXED list — real writes (`create`, `update`,
// `delete`) alongside refusals (`policy_denied`), skips (`skipped_fake_binary`, `skipped_no_content`) and
// failures (`edit_failed`, `apply_failed`). **`appliedOps.length` was used as "the build did something" in
// NINE places**, so a turn in which every operation was refused still:
//
//   * triggered the GitHub auto-sync, committing nothing;
//   * ran the UI polish pass;
//   * reported the reviewer block and `buildProgressed`;
//   * was billed and logged as `chat_build` rather than `chat_simple`, with a file count that included the
//     refusals;
//   * told the workspace which files had just changed.
//
// Three consumers had each derived their own answer and two were wrong, so the fix is one definition
// (`server/src/lib/appliedOps.js`) PUBLISHED in the payload as `changedPaths`. This asserts both halves:
// the definition behaves, and nobody re-derives it.
//
// Run:  node scripts/verify-applied-ops.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APPLIED_ACTIONS, UNRESOLVED_ACTIONS, isAppliedOp, isContentOp, appliedOnly, appliedPaths, appliedCount, unresolvedPaths,
} from '../server/src/lib/appliedOps.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

// A turn of the shape that produced this defect: one real write and one of every non-write.
const MIXED = [
  { path: 'server/index.js', action: 'update' },
  { path: 'server/new.js', action: 'create' },
  { path: 'server/gone.js', action: 'delete' },
  { path: 'server/denied.js', action: 'policy_denied' },
  { path: 'logo.png', action: 'skipped_fake_binary' },
  { path: 'server/empty.js', action: 'skipped_no_content' },
  { path: 'server/broken.js', action: 'edit_failed' },
  { path: 'server/boom.js', action: 'apply_failed' },
];

console.log('\n1. what counts as a write');
check('the three real writes are the whole allow-list', APPLIED_ACTIONS, ['create', 'update', 'delete']);
check('a write counts', [isAppliedOp({ action: 'create' }), isAppliedOp({ action: 'update' }), isAppliedOp({ action: 'delete' })], [true, true, true]);
check('a refusal, a skip and a failure do not',
  ['policy_denied', 'skipped_fake_binary', 'skipped_no_content', 'edit_failed', 'apply_failed'].map((a) => isAppliedOp({ action: a })),
  [false, false, false, false, false]);
// The allow-list matters in one direction only: an unknown action must NOT count as a write, because that
// is the direction that tells the operator a file changed when it did not.
check('an action nobody has thought of yet does not count', isAppliedOp({ action: 'something_new' }), false);
check('a missing or malformed op does not crash', [isAppliedOp(undefined), isAppliedOp(null), isAppliedOp({}), isAppliedOp('nope')], [false, false, false, false]);
// `isContentOp` is the narrower question the README gate asks; a delete is a change but not content.
check('content is create or update only',
  ['create', 'update', 'delete'].map((a) => isContentOp({ action: a })), [true, true, false]);

console.log('\n2. the turn that produced the defect');
check('only the three real writes are applied', appliedOnly(MIXED).map((o) => o.path), ['server/index.js', 'server/new.js', 'server/gone.js']);
check('the count excludes every non-write', appliedCount(MIXED), 3);
check('…and is NOT the length of the mixed list, which is the bug', appliedCount(MIXED) === MIXED.length, false);
check('the changed paths are the writes, in order', appliedPaths(MIXED), ['server/index.js', 'server/new.js', 'server/gone.js']);
check('a path written twice is listed once', appliedPaths([{ path: 'a.js', action: 'create' }, { path: 'a.js', action: 'update' }]), ['a.js']);
check('an op with no path does not become an empty highlight', appliedPaths([{ action: 'create' }]), []);
check('a turn where EVERYTHING was refused changed nothing',
  appliedCount(MIXED.filter((o) => o.action === 'policy_denied')), 0);
check('unresolved is a different question: only failures, not skips or refusals',
  unresolvedPaths(MIXED), ['server/broken.js', 'server/boom.js']);
check('…and it is de-duplicated too', unresolvedPaths([{ path: 'a.js', action: 'edit_failed' }, { path: 'a.js', action: 'apply_failed' }]), ['a.js']);
check('an empty list is not a crash', [appliedPaths([]), appliedCount(undefined), unresolvedPaths(null)], [[], 0, []]);

console.log('\n3. the server stops asking the mixed list how big it is');
const cwm = code('server/src/functions/chatWithMorpheus.js');
// The single most important assertion here: `appliedOps.length` is the defect. A bare one anywhere is a
// gate that counts refusals as work.
check('no gate counts the mixed list', /\bappliedOps\.length\b/.test(cwm), false);
check('…the gates count real writes instead', /appliedCount\(appliedOps\) > 0/.test(cwm), true);
check('…the logged file count is real writes', /fileCount: appliedCount\(appliedOps\)/.test(cwm), true);
check('…the polish count uses the shared rule', /polishCount = appliedCount\(appliedPolish\)/.test(cwm), true);
check('…and the unresolved list uses the shared rule', /unresolvedPaths\(appliedOps\)/.test(cwm), true);
// The rule itself must live in the module, not be re-spelled inline.
check('the rule is not re-spelled inline', /\^\(create\|update\|delete\)\$/.test(cwm), false);

console.log('\n4. the truth is PUBLISHED, and the consumers use it');
// A shared definition nobody receives is only half a fix: the browser cannot import server code, so the
// answer has to travel in the payload.
check('the payload publishes changedPaths', /changedPaths: appliedPaths\(appliedOps\)/.test(cwm), true);
check('…alongside the full list, so refusals can still be reported', /fileOperations: appliedOps/.test(cwm), true);
const ws = code('src/hooks/useWorkspace.js');
check('the workspace highlights what changed', /const changed = res\.data\.changedPaths \|\| \[\]/.test(ws), true);
check('…and no longer maps the mixed list into lastTouched', /setLastTouched\(prev => \(\{ paths: res\.data\.fileOperations/.test(ws), false);
check('…and no reload gate is driven by the mixed list', /fileOperations\?\.length/.test(ws), false);
check('…and the reload gates are driven by changedPaths', /changedPaths \|\| \[\]\)\.length > 0/.test(ws), true);
const chat = code('src/components/matrix/website/EmbedChat.jsx');
check('the embedded chat uses what changed', /changedPaths \|\| \[\]/.test(chat), true);
// Its old filter let a refused file and a failed edit through, because it only excluded one skip action.
check('…and no longer re-derives it from fileOperations', /fileOperations \|\| \[\]\)\.filter\(\(op\) => op\.action !== 'skipped_fake_binary'\)/.test(chat), false);

console.log('\n5. every function that ships an op list ships the answer too');
// Found by this guard catching its own fix: switching the client's test/autonomous reload gates to
// `changedPaths` would have BROKEN them, because those two functions returned only the mixed list. A rule
// about one function is not a rule. Counted per file, so a THIRD return in a file that already has one
// cannot ride on it.
const { readdirSync } = await import('node:fs');
const offenders = [];
for (const f of readdirSync(join(ROOT, 'server/src/functions')).filter((n) => n.endsWith('.js'))) {
  const src = code(join('server/src/functions', f));
  const ships = src.split('fileOperations: appliedOps').length - 1;
  const answers = src.split('changedPaths: appliedPaths(appliedOps)').length - 1;
  if (ships > answers) offenders.push(`${f} (${ships} op list(s), ${answers} answer(s))`);
}
check('no function ships a mixed op list without the changed paths', offenders, []);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ a refused operation can still read as a change — in the UI, in the log, or in a commit\n');
  process.exit(1);
}
console.log('"changed" now means written, and exactly one place decides it\n');
