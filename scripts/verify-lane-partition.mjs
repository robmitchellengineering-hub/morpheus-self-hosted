// Can a build be split into independent lanes — and does the splitter refuse the ones that would break it?
//
// THE CLAIM UNDER TEST
//
// Fan-out is only safe when the pieces are genuinely independent, and **the refusal is the feature** — it is
// what turns "this looks parallelisable" into a claim the system can check. So this guard is mostly about the
// refusals, and every one of them asserts the exact `reason` code rather than `ok === false`. That distinction
// is the whole point: `ok === false` is also what a fixture for a *different* refusal returns, so a test that
// only checks the boolean passes for the wrong reason and pins nothing. (Three masking incidents in this repo
// in one week came from exactly that shape — assert the thing you mean, not something correlated with it.)
//
// The two claims that are not refusals are the two that make the feature honest:
//   * lanes joined by a real import edge are MERGED, not run together — because concurrency removes the
//     `writtenSoFar` argument that sequential chunking was given precisely to stop a backend contradicting
//     itself (measured: "three files, three ideas of what `db` was");
//   * a non-JS lane (PHP above all — the first live customer target) is REPORTED as not dependency-checked
//     rather than silently treated as independent.
//
// And one claim protects Rob's rule — *"the guards shouldn't stop Morpheus from being able to build anything"*:
// a refusal is always "run this sequentially", never a throw, and the ordinary path (no `lanes` proposed) must
// not even read the workspace.
//
// This is a pure module (`importGraph.js` has no imports at all), so it runs in the no-install guards job.
//
// Run:  node scripts/verify-lane-partition.mjs
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const { partitionLanes, planCoderWork, runLaneUnits, laneVerdicts, describeLaneIssues, fileOfFinding, mergeLaneResults, firstLaneError, maxLanesFromEnv, DEFAULT_MAX_LANES, MAX_LANES_CEILING, MAX_LANES_ENV } = await import(
  '../server/src/lib/lanePartition.js'
);

let checks = 0;
let failures = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else {
    console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`);
    failures++;
  }
}

console.log('\nA build only fans out when its pieces are genuinely independent\n');

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────────
// Four small files, so a lane can be created or dropped without disturbing the others' arithmetic.
const P = ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js'];
const twoClean = () => [
  { name: 'templates', files: ['src/a.js', 'src/b.js'] },
  { name: 'bookings', files: ['src/c.js', 'src/d.js'] },
];
/** `src/a.js` imports `src/d.js` — a real edge, resolvable through the graph, that crosses the clean split. */
const existingWithEdge = [
  { path: 'src/a.js', content: "import value from './d.js';\n" },
  { path: 'src/b.js', content: '// b\n' },
  { path: 'src/c.js', content: '// c\n' },
  { path: 'src/d.js', content: 'export default 1;\n' },
];

// ── 1. the ordinary case ─────────────────────────────────────────────────────────────────────────────────
const clean = partitionLanes({ plannedFiles: P, lanes: twoClean() });
check('two independent lanes are accepted', clean.ok, true);
check('…with the lanes exactly as proposed, in order', clean.lanes, twoClean());
check('…and nothing to report', clean.notes, []);

// ── 2. THE refusal: lanes that name the same file ────────────────────────────────────────────────────────
// Two lanes writing one path is H9 at file scale, and it is unrecoverable because the result does not say it
// happened — the last completion simply wins.
const shared = partitionLanes({
  plannedFiles: P,
  lanes: [
    { name: 'templates', files: ['src/a.js', 'src/b.js'] },
    { name: 'bookings', files: ['src/b.js', 'src/c.js'] },
    { name: 'emails', files: ['src/d.js'] },
  ],
});
check('a file in two lanes is refused', shared.reason, 'shared-file');
check('…and the refusal names the file and both lanes', /"src\/b\.js" is in both lane "templates" and lane "bookings"/.test(shared.detail), true);
check('…so no lanes are returned to run', shared.lanes, []);

// ── 3. the quiet failure: a planned file in NO lane ──────────────────────────────────────────────────────
// Every lane finishes green and a file the plan called for was written by nobody.
const missing = partitionLanes({
  plannedFiles: P,
  lanes: [
    { name: 'templates', files: ['src/a.js'] },
    { name: 'bookings', files: ['src/b.js'] },
  ],
});
check('a planned file in no lane is refused', missing.reason, 'missing-file');
check('…and the refusal names what would never be written', /src\/c\.js, src\/d\.js/.test(missing.detail), true);

// ── 4. a lane may not introduce a path the plan never listed ─────────────────────────────────────────────
const unplanned = partitionLanes({
  plannedFiles: P,
  lanes: [
    { name: 'templates', files: ['src/a.js', 'src/invented.js'] },
    { name: 'bookings', files: ['src/b.js', 'src/c.js', 'src/d.js'] },
  ],
});
check('a path outside the plan is refused', unplanned.reason, 'unplanned-file');
check('…naming the invented path', /"src\/invented\.js"/.test(unplanned.detail), true);

// ── 5. the shapes that cannot be reported per lane ───────────────────────────────────────────────────────
check('a lane with no files is refused',
  partitionLanes({ plannedFiles: P, lanes: [{ name: 'templates', files: [] }, { name: 'b', files: ['src/b.js'] }] }).reason, 'empty-lane');
check('two lanes with one name are refused',
  partitionLanes({ plannedFiles: P, lanes: [{ name: 'same', files: ['src/a.js', 'src/b.js'] }, { name: 'same', files: ['src/c.js', 'src/d.js'] }] }).reason, 'duplicate-lane-name');
check('a lane with no name is refused',
  partitionLanes({ plannedFiles: P, lanes: [{ files: ['src/a.js', 'src/b.js'] }, { name: 'b', files: ['src/c.js', 'src/d.js'] }] }).reason, 'bad-lane-name');
check('a lane that does not list files is refused',
  partitionLanes({ plannedFiles: P, lanes: [{ name: 'a' }, { name: 'b', files: ['src/b.js', 'src/c.js', 'src/d.js'] }] }).reason, 'bad-lane-files');
check('one lane is not a split',
  partitionLanes({ plannedFiles: P, lanes: [{ name: 'all', files: P }] }).reason, 'single-lane');
check('no lanes at all is not a split',
  partitionLanes({ plannedFiles: P, lanes: [] }).reason, 'no-lanes');
check('a plan with no files is not a split',
  partitionLanes({ plannedFiles: [], lanes: twoClean() }).reason, 'no-planned-files');

// ── 6. dependencies: merge, do not run together ──────────────────────────────────────────────────────────
// The measured hazard. Two lanes with no shared file but an import between them cannot run at once, because
// neither can see the other's output — the reason the sequential chunk pass carries `writtenSoFar`.
const depTwo = partitionLanes({ plannedFiles: P, existingFiles: existingWithEdge, lanes: twoClean() });
check('lanes joined by an import edge are not run together', depTwo.reason, 'no-independent-units');
check('…and the operator is told what merged and why',
  /Merged 2 lanes that depend on each other \(templates \+ bookings\) — src\/a\.js imports src\/d\.js\./.test(depTwo.notes.join(' ')), true);

// The same edge with a third, genuinely independent lane: the two merge and the third survives, so a dependency
// narrows the split instead of cancelling it.
const depThree = partitionLanes({
  plannedFiles: P,
  existingFiles: existingWithEdge,
  lanes: [
    { name: 'templates', files: ['src/a.js'] },
    { name: 'bookings', files: ['src/c.js', 'src/d.js'] },
    { name: 'emails', files: ['src/b.js'] },
  ],
});
check('a dependent pair merges while an independent lane survives', depThree.ok, true);
check('…into exactly two lanes', depThree.lanes.map((l) => l.name), ['templates', 'emails']);
check('…with every file still in exactly one lane', depThree.lanes.flatMap((l) => l.files).sort(), [...P].sort());
check('…and the merge is recorded for the operator', depThree.merged, [{ lanes: ['templates', 'bookings'], into: 'templates', reason: 'dependency' }]);
check('…including the path that caused it', /src\/a\.js imports src\/d\.js/.test(depThree.notes.join(' ')), true);

// Independence must be a real check, not a blanket refusal: the same files with NO edge stay split.
const noEdge = partitionLanes({
  plannedFiles: P,
  existingFiles: existingWithEdge.map((f) => (f.path === 'src/a.js' ? { ...f, content: "import value from './b.js';\n" } : f)),
  lanes: twoClean(),
});
check('an import that stays inside its own lane does not force a merge', noEdge.ok, true);
check('…and reports no merge', noEdge.merged, []);

// ── 7. the honest limit: a lane this check cannot read ───────────────────────────────────────────────────
// The import graph is ESM-only. A PHP lane — WordPress is the first live customer target — is NOT
// dependency-checked, and saying so is the difference between a proposal and a false assurance.
const php = partitionLanes({
  plannedFiles: ['wp/page.php', 'wp/header.php', 'src/c.js', 'src/d.js'],
  lanes: [
    { name: 'templates', files: ['wp/page.php', 'src/c.js'] },
    { name: 'bookings', files: ['wp/header.php', 'src/d.js'] },
  ],
});
check('a PHP lane is still allowed to fan out', php.ok, true);
check('…but the two unchecked files are counted', php.unchecked, 2);
check('…and reported as a proposal, not a proof', /2 non-JS file\(s\).*could not be dependency-checked/.test(php.notes.join(' ')), true);
check('a JS-only split claims nothing unchecked', clean.unchecked, 0);
check('…and adds no such note', /could not be dependency-checked/.test(clean.notes.join(' ')), false);

// ── 8. the cap is a cap ─────────────────────────────────────────────────────────────────────────────────
// Six single-file lanes, deliberately more than the ceiling, so "clamped" is visible in the COUNT and not only
// in the flag — a fixture that proposed exactly the ceiling could not tell a working cap from a missing one.
const P6 = [...P, 'src/e.js', 'src/f.js'];
const oneEach = P6.map((f, i) => ({ name: `lane${i}`, files: [f] }));
const capped = partitionLanes({ plannedFiles: P6, lanes: oneEach, maxLanes: 99 });
check('more lanes than the ceiling are clamped, not honoured', capped.lanes.length, MAX_LANES_CEILING);
check('…and the clamp is reported', capped.clamped, true);
check('…with every file still in exactly one lane', capped.lanes.flatMap((l) => l.files).sort(), [...P6].sort());
check('…and no file in two lanes', new Set(capped.lanes.flatMap((l) => l.files)).size, P6.length);
check('the default is inside the ceiling', DEFAULT_MAX_LANES <= MAX_LANES_CEILING, true);
check('a caller cannot ask for fewer than one lane',
  partitionLanes({ plannedFiles: P, lanes: oneEach.slice(0, 4), maxLanes: 0 }).reason, 'no-independent-units');

// ── 9. Rob's rule: a refusal costs speed, never a build ──────────────────────────────────────────────────
// Every refusal returns the same shape, and `ok:false` always means "no lanes" — so a caller cannot half-use a
// split that was refused.
const garbage = [
  undefined,
  null,
  {},
  { plannedFiles: P },
  { plannedFiles: P, lanes: 'nope' },
  { plannedFiles: P, lanes: [null, { name: 'b', files: ['src/b.js'] }] },
  { plannedFiles: P, lanes: [{ name: 'a', files: 'nope' }, { name: 'b', files: ['src/b.js'] }] },
  { plannedFiles: null, lanes: null },
  { plannedFiles: P, lanes: twoClean(), existingFiles: 'nope' },
  { plannedFiles: P, lanes: twoClean(), existingFiles: [null, { path: 42 }] },
  { plannedFiles: P, lanes: twoClean(), existingFiles: [{ path: 'src/a.js', content: "import from './';\nimport\nimport x from" }] },
  // Two inputs that genuinely THROW inside the splitter, so the never-throw claim is tested by a real throw
  // rather than by inputs that merely return early. Without these the `catch` could be deleted and every
  // assertion above would still pass.
  { plannedFiles: P, lanes: [{ name: 'a', files: ['src/a.js'] }, { get files() { throw new Error('boom'); } }] },
  { plannedFiles: P, lanes: twoClean(), existingFiles: [{ path: 'src/a.js', get content() { throw new Error('boom'); } }] },
];
const thrown = [];
for (const g of garbage) {
  try {
    const r = partitionLanes(g);
    if (typeof r?.ok !== 'boolean' || (r.ok === false && r.lanes.length !== 0)) thrown.push(JSON.stringify(g));
  } catch (err) {
    thrown.push(`${JSON.stringify(g)} -> threw ${err.message}`);
  }
}
check('malformed input is refused, never thrown', thrown, []);

// The ordinary build pays nothing: with no `lanes` proposed the workspace is not even read, which is proven by
// handing it an `existingFiles` whose `path` throws on access.
let touched = false;
const untouched = partitionLanes({
  plannedFiles: P,
  lanes: null,
  existingFiles: [{ get path() { touched = true; return 'src/a.js'; }, content: "import x from './d.js';" }],
});
check('a build with no proposed split still runs sequentially', untouched.reason, 'no-lanes');
check('…and never reads the workspace to find that out', touched, false);

// ── 10. the fan-out: which files become concurrent units, and in what order they merge ───────────────────
//
// The part that can be WRONG in a way a test can see. The model call cannot, so it stays in chatWithMorpheus.js
// and these two functions carry the claims: a chunk never spans two lanes, no file is lost or duplicated, and the
// merge order is unit order rather than completion order.

// (a) NO ACCEPTED SPLIT — the ordinary build — is exactly one unit holding today's flat chunking. This is what
// makes the N sweep a one-variable comparison against the current behaviour instead of a second code path.
const flat = planCoderWork({ laneSplit: null, plannedFiles: P6, filesPerStep: 3, maxLanes: 3 });
check('no split means one unit', flat.units.length, 1);
check('…named as the whole build, not a lane', flat.units[0].name, null);
check('…chunked exactly as the sequential loop did', flat.units[0].chunks, [['src/a.js', 'src/b.js', 'src/c.js'], ['src/d.js', 'src/e.js', 'src/f.js']]);
check('…and not concurrent', flat.concurrent, false);

// (b) N=1 MEANS SEQUENTIAL, AND IT IS THE WHOLE POINT OF THE PARAMETER: the same plan that would fan out at 3
// collapses to the identical single unit at 1, so the sweep compares against today rather than a memory.
const split6 = partitionLanes({ plannedFiles: P6, lanes: [{ name: 'left', files: P6.slice(0, 3) }, { name: 'right', files: P6.slice(3) }] });
check('the fixture really is splittable', split6.ok, true);
const atOne = planCoderWork({ laneSplit: split6, plannedFiles: P6, filesPerStep: 3, maxLanes: 1 });
check('N=1 collapses the split to a single sequential unit', atOne.concurrent, false);
check('…with exactly the flat chunking of no-split', atOne, flat);

// (c) THE REAL SPLIT: one unit per lane, in lane order.
const atThree = planCoderWork({ laneSplit: split6, plannedFiles: P6, filesPerStep: 3, maxLanes: 3 });
check('an accepted split becomes one unit per lane', atThree.units.map((u) => u.name), ['left', 'right']);
check('…and says it is concurrent', atThree.concurrent, true);
check('…with each lane chunked internally', atThree.units[0].chunks, [P6.slice(0, 3)]);
check('…and the second lane’s own files', atThree.units[1].chunks, [P6.slice(3)]);

// ⚠️ A CHUNK MAY NEVER SPAN TWO LANES. If it did, one coder call would be writing files from both lanes at once —
// which is the shared-writer problem again, one level down, and invisible in the output.
const acrossLanes = planCoderWork({
  laneSplit: partitionLanes({ plannedFiles: P6, lanes: [{ name: 'a', files: [P6[0]] }, { name: 'b', files: P6.slice(1) }] }),
  plannedFiles: P6,
  filesPerStep: 6, // deliberately bigger than any lane, to try to make one chunk swallow both
  maxLanes: 3,
});
const laneOfFile = new Map();
for (const u of acrossLanes.units) for (const c of u.chunks) for (const f of c) laneOfFile.set(f, u.name);
const spanned = acrossLanes.units.filter((u) => u.chunks.some((c) => c.some((f) => laneOfFile.get(f) !== u.name)));
check('no chunk spans two lanes, even when the step size is larger than a lane', spanned.length, 0);

// (d) COVERAGE: every planned file is in exactly one chunk. A file dropped here is never written, and nothing
// downstream would say so — the same quiet failure the splitter refuses one level up.
const coveredFiles = acrossLanes.units.flatMap((u) => u.chunks.flat());
check('every planned file is assigned', [...coveredFiles].sort(), [...P6].sort());
check('…exactly once', new Set(coveredFiles).size, P6.length);
check('a plan with no files produces no units', planCoderWork({ laneSplit: null, plannedFiles: [], maxLanes: 3 }).units, []);
check('a garbage step size falls back rather than looping forever', planCoderWork({ laneSplit: null, plannedFiles: P, filesPerStep: 0, maxLanes: 3 }).units[0].chunks.length, 2);

// (e) MERGE ORDER IS UNIT ORDER, NEVER COMPLETION ORDER. If a slow lane's output landed last, the same plan
// would produce a different build on every run — the property that makes a parallel build untrustworthy.
const merged = mergeLaneResults([
  { ops: [{ path: 'src/a.js' }, { path: 'src/b.js' }], truncated: [], model: 'm1' },
  { ops: [{ path: 'src/c.js' }], truncated: ['src/d.js'], model: 'm2' },
]);
check('units merge in the order they were given', merged.ops.map((o) => o.path), ['src/a.js', 'src/b.js', 'src/c.js']);
check('…their unwritten files too', merged.truncated, ['src/d.js']);
check('…and the model reported is the last one that had one', merged.model, 'm2');
check('a unit with no model does not erase the previous one',
  mergeLaneResults([{ ops: [], model: 'm1' }, { ops: [], model: null }]).model, 'm1');
check('malformed unit results are skipped, not thrown', mergeLaneResults([null, 'x', { ops: 'nope' }, { ops: [{ path: 'p' }] }]).ops, [{ path: 'p' }]);
check('merging nothing is empty, not a crash', mergeLaneResults(undefined), { ops: [], truncated: [], model: undefined });

// (f) A FAILURE IS REPORTED BY THE FIRST UNIT IN ORDER — deterministic, so which error ends the turn cannot
// depend on which model call happened to fail fastest.
const settled = [{ status: 'fulfilled', value: { ops: [] } }, { status: 'rejected', reason: new Error('second') }, { status: 'rejected', reason: new Error('third') }];
check('the first failure in unit order is the one reported', firstLaneError(settled).message, 'second');
check('…and no failure is null, not undefined', firstLaneError([{ status: 'fulfilled', value: {} }]), null);

// (g) THE PARAMETER. Read from the environment so the sweep can change it between two runs of one task without a
// deploy, and unreadable input falls back rather than stopping a build.
check('the default lane count is 3', maxLanesFromEnv({}), DEFAULT_MAX_LANES);
check('…and the entry for it is the documented name', MAX_LANES_ENV, 'MORPHEUS_MAX_LANES');
check('an unset variable uses the default', maxLanesFromEnv({ [MAX_LANES_ENV]: undefined }), DEFAULT_MAX_LANES);
check('1 means sequential and is honoured', maxLanesFromEnv({ [MAX_LANES_ENV]: '1' }), 1);
check('a higher ask is clamped to the ceiling', maxLanesFromEnv({ [MAX_LANES_ENV]: '99' }), MAX_LANES_CEILING);
check('nonsense falls back to the default', maxLanesFromEnv({ [MAX_LANES_ENV]: 'lots' }), DEFAULT_MAX_LANES);
check('…and so does an empty string', maxLanesFromEnv({ [MAX_LANES_ENV]: '   ' }), DEFAULT_MAX_LANES);
check('a missing env object is not a crash', maxLanesFromEnv(null), DEFAULT_MAX_LANES);

// ── 11. the wiring, which is what makes it a guard rather than a test ────────────────────────────────────
const gate = read('scripts/verify.mjs');
const ci = read('.github/workflows/ci.yml');
const chat = read('server/src/functions/chatWithMorpheus.js');
check('it is in verify.mjs\'s HARD list', /'verify-lane-partition\.mjs'/.test(gate), true);
check('…and CI runs it', /node scripts\/verify-lane-partition\.mjs/.test(ci), true);
// And the module is actually consulted by the build, so this is a decision the pipeline makes rather than a
// library nobody calls. A guard whose subject is dead code is the "guard that only polices us" shape — it would
// keep passing while the feature it describes does nothing.
check('the split is judged by the build that would use it', /partitionLanes\(/.test(chat), true);
check('…the fan-out is planned through the tested function', /planCoderWork\(/.test(chat), true);
// Scheduling used to be four lines inside the handler, which made the feature's central claim — that the units
// really run at once — untestable, and left the guard matching a `Promise.allSettled` in a 2,600-line file. It is
// now one call into a function that takes `runUnit` injected, so §13 can execute the claim instead of reading it.
check('…and the units are SCHEDULED through the tested function', /runLaneUnits\(\{ units: work\.units, runUnit, concurrent: work\.concurrent \}\)/.test(chat), true);
// Anchored on the CALL, not the word: an earlier version of this check failed because a comment in the handler
// explains that the scheduling used to be a `Promise.allSettled` there — a check catching its own prose.
check('…with the scheduling no longer inlined in the handler', (chat.match(/await Promise\.allSettled\(/g) || []).length, 0);
check('…it lives in the tested module instead', /await Promise\.allSettled\(list\.map/.test(read('server/src/lib/lanePartition.js')), true);
check('the scheduling function is where order and failure are decided', /firstLaneError\(settled\)/.test(read('server/src/lib/lanePartition.js')), true);
// The lane count must come from the parameter, not a literal — a hardcoded N would make the sweep measure nothing.
check('…and N comes from the environment parameter', /maxLanes: maxLanesFromEnv\(\)/.test(chat), true);

// ── 12. per-lane visibility, and the client change it does NOT need ──────────────────────────────────────
// Design §4.2: "N lanes, each with its own state". A lane gets its own row by reusing the existing stage
// protocol with a lane-specific id, so there is no second event type and no second progress surface.
check('a lane gets its own stage id', /const laneStage = unit\.name \? `coder:\$\{unit\.name\}` : null;/.test(chat), true);
check('…labelled with the lane name', /label: `Writing \$\{unit\.name\}`/.test(chat), true);
// The whole-build unit is the ordinary sequential build AND every refusal, so it must not grow an extra row.
check('…while the whole-build unit adds no row', /: null;/.test(chat) && /if \(laneStage\) stages\.start\(laneStage/.test(chat), true);
check('…and a lane that throws cannot leave its row spinning', /finally \{\n\s+if \(laneStage\) stages\.done\(laneStage\);/.test(chat), true);

// Cost is itemised per lane (design §3.5) through the usage row's `task` label — previously the coder's calls
// carried none at all, in ANY of the eight places it is invoked. Counted rather than checked for presence: a
// presence check passes while seven call sites stay unattributable, which is the state this replaced.
const coderCallSites = (chat.match(/role: 'coder',/g) || []).length;
const taskLabels = (chat.match(/^\s+task[,:]/gm) || []).length;
check('every coder call site carries a task label', taskLabels, coderCallSites);
check('…the two lane-aware sites take it from the lane name', (chat.match(/^\s+task,$/gm) || []).length, 2);
check('…and the rest are named for what they actually are',
  ['coder', 'fix_syntax', 'fix_caller', 'fix_a11y', 'polish']
    .map((t) => (chat.match(new RegExp(`task: '${t}',`, 'g')) || []).length),
  [2, 1, 1, 1, 1]);
check('…built from the lane name', /const task = unit\.name \? `coder:\$\{unit\.name\}` : 'coder';/.test(chat), true);
// A lane stage is not one of the fixed pipeline stages, so the emitter must accept an explicit label and role —
// without them the row would render with no label and an ETA computed from an unknown role.
check('the stage emitter accepts a lane label and role', /const start = \(stage, opts = \{\}\) => \{/.test(chat), true);
check('…and still falls back for the fixed stages', /opts\.label \|\| STAGE_LABELS\[stage\] \|\| stage/.test(chat), true);

// THE CLIENT CHANGE THAT IS NOT NEEDED, pinned so a refactor to a fixed stage allowlist fails here instead of
// silently dropping every lane's row.
const workspace = read('src/hooks/useWorkspace.js');
check('the client appends a row for any stage id', /\{ stage: evt\.stage, label: evt\.label, status: 'active'/.test(workspace), true);
check('…and flips the row with the matching id', /s\.stage === evt\.stage && s\.status === 'active'/.test(workspace), true);
check('…and the panel renders the server’s label', /\{s\.label\}/.test(read('src/components/matrix/MorpheusPipelineStatus.jsx')), true);

// ── 13. THE CLAIM NOTHING COULD TEST: do the units actually run AT ONCE? ─────────────────────────────────
// This is the whole feature. Until `runLaneUnits` took `runUnit` injected, the answer lived in four lines inside a
// 2,600-line handler and the only thing assertable was the TEXT of a `Promise.allSettled` call — a statement about
// the file, not about the behaviour, and it would have kept passing if someone replaced it with a `for` loop.
//
// Real timers, real overlap. These are the slowest checks in this guard (~0.5s) and they earn it: without them
// "the lanes run in parallel" is a comment.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LANE_MS = 150;
const mkUnit = (name) => ({ name, chunks: [[`${name}.js`]] });
const okUnit = async (u) => { await sleep(LANE_MS); return { ops: [{ path: `${u.name}.js`, action: 'create' }], truncated: [], model: 'm1' }; };

let t0 = Date.now();
const parallel = await runLaneUnits({ units: [mkUnit('a'), mkUnit('b'), mkUnit('c')], concurrent: true, runUnit: okUnit });
const parallelMs = Date.now() - t0;
check('three 150ms lanes OVERLAP rather than queue', parallelMs < 2 * LANE_MS, true);

// …and the sequential path really queues. This is the arm the N sweep compares against, so "concurrent:false is
// just slower in principle" would make the whole measurement meaningless.
t0 = Date.now();
await runLaneUnits({ units: [mkUnit('a'), mkUnit('b'), mkUnit('c')], concurrent: false, runUnit: okUnit });
const sequentialMs = Date.now() - t0;
check('…while concurrent:false really does queue them', sequentialMs >= 3 * LANE_MS, true);
check('…so the fan-out is measurably faster than the baseline it replaced', parallelMs < sequentialMs, true);
check('…and both merged every lane', parallel.ops.map((o) => o.path), ['a.js', 'b.js', 'c.js']);

// ORDER IS LANE ORDER, NOT COMPLETION ORDER. Make the FIRST unit the slowest: it must still merge first, which is
// the property that stops the same plan producing a different build depending on network timing.
const completion = [];
const ordered = await runLaneUnits({
  units: [mkUnit('slow'), mkUnit('fast')],
  concurrent: true,
  runUnit: async (u) => {
    await sleep(u.name === 'slow' ? 120 : 5);
    completion.push(u.name);
    return { ops: [{ path: `${u.name}.js`, action: 'create' }], truncated: [], model: `m-${u.name}` };
  },
});
check('the slower first lane still merges FIRST', ordered.ops.map((o) => o.path), ['slow.js', 'fast.js']);
check('…even though it finished last', completion, ['fast', 'slow']);
// UNIT order, so the last lane is `fast` — this is the same "last chunk's model wins" the sequential loop did,
// and the point is that it is chosen by position rather than by which call returned first.
check('…and the reported model follows unit order, not completion order', ordered.model, 'm-fast');

// A FAILURE IS THE FIRST LANE'S, DETERMINISTICALLY — not whichever model call happened to fail fastest.
let caught = null;
try {
  await runLaneUnits({
    units: [mkUnit('first'), mkUnit('second')],
    concurrent: true,
    runUnit: async (u) => {
      if (u.name === 'first') throw new Error('first lane failed');
      await sleep(30); // the SECOND lane fails later, so "fastest failure" would pick the other one
      throw new Error('second lane failed');
    },
  });
} catch (err) {
  caught = err;
}
check('a failed lane ends the run', caught?.message, 'first lane failed');

// And the sequential path keeps today's behaviour: a failure propagates at once, with no wrapper swallowing it.
let seqErr = null;
try {
  await runLaneUnits({ units: [mkUnit('a')], concurrent: false, runUnit: async () => { throw new Error('boom'); } });
} catch (err) {
  seqErr = err;
}
check('…and a sequential failure propagates too', seqErr?.message, 'boom');
check('an empty unit list is not a crash', await runLaneUnits({ units: [], concurrent: true, runUnit: okUnit }), { ops: [], truncated: [], model: undefined });

// ── 14. PER-LANE VERDICTS: whose files are the remaining findings against? ───────────────────────────────
// The gates report findings against FILES; the operator is watching LANES. This maps one to the other, and it is
// asked AFTER the gates have run — a verdict taken at the end of a lane's coding pass would be wrong on most
// multi-file builds, because the syntax gate and its fix loop are what repair them.
const VL = [{ name: 'data layer', files: ['db.js', 'schema.js'] }, { name: 'list view', files: ['list.js'] }];
const v1 = laneVerdicts({ lanes: VL, findings: ['db.js', { file: 'list.js', text: 'broken import' }] });
check('a finding is attributed to the lane that owns the file', v1.verdicts.map((v) => v.issues.length), [1, 1]);
check('…and a clean lane carries nothing', laneVerdicts({ lanes: VL, findings: ['db.js'] }).verdicts[1].issues, []);
check('…with every lane reported even when it has no findings', v1.verdicts.map((v) => v.name), ['data layer', 'list view']);
// The gate call sites in this repo do not agree on a shape, so all of them are accepted — a bare path, an object
// with `file` or `path`, and the DISPLAY STRING the gates actually build. A finder that understood only one shape
// would silently report a clean build.
check('both object shapes are understood',
  laneVerdicts({ lanes: VL, findings: ['db.js', { path: 'schema.js' }, { file: 'db.js' }] }).verdicts[0].issues.length, 3);
// ⚠️ THE REAL FORMAT, AND THE REASON THIS CHECK EXISTS. Every findings list in chatWithMorpheus.js holds strings
// built as `${e.file}${e.line ? ':' + e.line : ''} — ${e.text}` — the file has to be read back out. A first
// version of `laneVerdicts` looked only for an object's `file`, so fed the real lists it attributed EVERY finding
// to `unowned` and reported every lane clean. These fixtures are that format verbatim.
check('a "path:line — text" finding is attributed to its file', fileOfFinding('src/a.js:3 — Unexpected token }'), 'src/a.js');
check('…one without a line number too', fileOfFinding('src/a.js — something broke'), 'src/a.js');
check('…a bare path is a path, not a display string', fileOfFinding('src/a.js'), 'src/a.js');
const vReal = laneVerdicts({
  lanes: [{ name: 'data layer', files: ['db.js'] }, { name: 'list view', files: ['list.jsx'] }],
  findings: ['db.js:12 — Unexpected token }', 'list.jsx:3 — img has no alt text'],
});
check('…so a build with a broken file does NOT read as every lane clean', vReal.verdicts.map((v) => v.issues.length), [1, 1]);
check('the display format the gates build is the one this parses',
  (chat.match(/`\$\{e\.file\}\$\{e\.line \? ':' \+ e\.line : ''\} — \$\{e\.text\}`/g) || []).length >= 3, true);
// ⚠️ A FINDING ON A FILE IN NO LANE MUST NOT VANISH. The coder can write something the plan never listed; that is
// exactly the case the lanes cannot explain, so it is returned rather than dropped into a lane at random.
const v2 = laneVerdicts({ lanes: VL, findings: ['stray.js', 'db.js', null] });
check('a finding against a file in no lane is returned, not dropped', v2.unowned, ['stray.js', null]);
check('…and it does not inflate any lane', v2.verdicts.map((v) => v.issues.length), [1, 0]);
check('no lanes and no findings is empty, not a crash', laneVerdicts(), { verdicts: [], unowned: [] });
check('garbage findings are tolerated', laneVerdicts({ lanes: VL, findings: 'nope' }).verdicts.length, 2);

check('the row suffix counts files', describeLaneIssues(1), '1 file needs attention');
check('…and pluralises', describeLaneIssues(3), '3 files need attention');
check('…and says nothing for a clean lane', describeLaneIssues(0), '');

// ── the wiring: emitted late, drawn differently, and never as a silent green ─────────────────────────────
// Positional, not a character window: the call must come AFTER the last gate that can put a finding in a list.
// (A `[\s\S]{0,200}` window here failed the moment a comment grew inside it — the same brittle-window mistake as
// the 1800-character slice in verify-stage-observability.)
const verdictAt = chat.indexOf('laneVerdicts({');
const lastGateAt = Math.max(...['syntaxCritical = syntaxErrors', 'truncatedFiles.push', 'deepVerifyCritical = deep.errors', 'a11yNotes = a11yFindings']
  .map((needle) => chat.indexOf(needle)));
check('the verdict is computed after the gates have run', verdictAt > 0 && lastGateAt > 0 && verdictAt > lastGateAt, true);
// Counted against the lists that exist, so a findings source added later and left out of this array fails here.
// `syntaxCritical` was left out once — the finding that matters most (a file that still does not parse) — which
// would have made the worst case the only case with no verdict.
// Anchored on the CALL, because `findings: [` also appears in the security and UI-feedback report shapes above it.
const findingsArg = (/findings: \[([^\]]*)\]/.exec(chat.slice(verdictAt)) || [])[1] || '';
const findingsSources = (findingsArg.match(/\.\.\.(\w+)/g) || []).map((x) => x.slice(3));
check('the verdict reads every gate list, including the syntax one',
  ['syntaxCritical', 'truncatedFiles', 'callerCritical', 'schemaCritical', 'a11yNotes', 'deepVerifyCritical'].every((n) => findingsSources.includes(n)), true);
for (const name of ['syntaxCritical', 'truncatedFiles', 'callerCritical', 'schemaCritical', 'a11yNotes', 'deepVerifyCritical']) {
  check(`…and that list exists (${name})`, new RegExp(`let ${name} = \\[\\]`).test(chat), true);
}
check('…and only for a build that actually has lanes', /if \(laneSplit\?\.ok\) \{\n\s+const \{ verdicts, unowned \}/.test(chat), true);
check('a lane with findings is marked FAILED on its own row', /stages\.fail\(`coder:\$\{v\.name\}`/.test(chat), true);
check('…and unowned findings are reported rather than dropped', /if \(unowned\.length > 0\)/.test(chat), true);
// The emitter must actually send a status the client acts on.
check('the emitter sends a distinct failed status', /status: 'failed'/.test(chat), true);
const ws = read('src/hooks/useWorkspace.js');
// ⚠️ MATCHED ON THE ID ALONE, not `&& s.status === 'active'`: the lane's row was closed as done before the gates
// ran, so requiring 'active' would leave every failed lane showing a green tick — a false pass drawn on screen.
check('the client flips the row it already closed', /evt\.status === 'failed'/.test(ws) && /s\.stage === evt\.stage\n/.test(ws), true);
// Anchored so that ADDING the condition fails here: the map line must end right after `evt.stage`. Requiring
// 'active' would leave a lane whose files still have findings drawn with a green tick — a false pass, on screen.
check('…without requiring the row to still be active', /evt\.status === 'failed'\) \{[\s\S]{0,400}?return prev\.map\(s => \(s\.stage === evt\.stage\s*\n/.test(ws), true);
check('…and the panel draws it differently from a tick', /isFailed \? '✗' : '✓'/.test(read('src/components/matrix/MorpheusPipelineStatus.jsx')), true);

console.log(`\n${checks - failures}/${checks} checks passed\n`);
if (failures > 0) process.exit(1);
