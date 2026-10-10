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

const { partitionLanes, planCoderWork, mergeLaneResults, firstLaneError, maxLanesFromEnv, DEFAULT_MAX_LANES, MAX_LANES_CEILING, MAX_LANES_ENV } = await import(
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
check('…the units are merged through the tested function', /mergeLaneResults\(/.test(chat), true);
check('…a unit failure is chosen deterministically', /firstLaneError\(settled\)/.test(chat), true);
// The lane count must come from the parameter, not a literal — a hardcoded N would make the sweep measure nothing.
check('…and N comes from the environment parameter', /maxLanes: maxLanesFromEnv\(\)/.test(chat), true);

console.log(`\n${checks - failures}/${checks} checks passed\n`);
if (failures > 0) process.exit(1);
