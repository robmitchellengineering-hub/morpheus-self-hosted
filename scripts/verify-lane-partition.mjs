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

const { partitionLanes, DEFAULT_MAX_LANES, MAX_LANES_CEILING } = await import(
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

// ── 10. the wiring, which is what makes it a guard rather than a test ────────────────────────────────────
const gate = read('scripts/verify.mjs');
const ci = read('.github/workflows/ci.yml');
check('it is in verify.mjs\'s HARD list', /'verify-lane-partition\.mjs'/.test(gate), true);
check('…and CI runs it', /node scripts\/verify-lane-partition\.mjs/.test(ci), true);
// And the module is actually consulted by the build, so this is a decision the pipeline makes rather than a
// library nobody calls. A guard whose subject is dead code is the "guard that only polices us" shape — it would
// keep passing while the feature it describes does nothing.
check('the split is judged by the build that would use it',
  /partitionLanes/.test(read('server/src/functions/chatWithMorpheus.js')), true);

console.log(`\n${checks - failures}/${checks} checks passed\n`);
if (failures > 0) process.exit(1);
