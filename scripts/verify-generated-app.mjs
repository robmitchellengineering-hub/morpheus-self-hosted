// Would what we generate actually run for the operator?
//
// WHY THIS EXISTS. The "self-hosted" posture promises one command, no account, no network. On
// 2026-09-29 that promise was tested for real — a self-hosted backend was generated and run — and the app
// failed twice before answering anything:
//
//   1. it declared `better-sqlite3`, which publishes no prebuilt binary for Node 22 and whose source does
//      not compile against that V8, so the FIRST command in its README failed; and
//   2. `server/db.js` exported `{ initialize, getDb }` while `server/routes/tasks.js` called
//      `db.prepare(...)`, so the first request threw.
//
// `verify-server-imports.mjs` cannot see either: it checks that imports RESOLVE, not that the shape a
// module receives is the shape it uses. And nothing in the repo ran generated output at all.
//
// So this guard does two things, and both matter:
//   * it checks the fixture — a real, minimal, self-contained app — is ACCEPTED, so the checker is not
//     merely allergic to everything; and
//   * it checks the checker REJECTS each defect that was actually produced, reconstructed from the real
//     output rather than described.
//
// What it does not do is prove an app runs. That is `scripts/smoke-generated-app.mjs`, which installs and
// boots the same fixture; this file is the part that runs in CI's no-install job.
//
// Run:  node scripts/verify-generated-app.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generatedAppProblems, dependencyProblems, moduleContractProblems, entryPointProblems,
  packageJsonOf, declaredDependencies, withoutComments, RUNNABLE_APP_REQUIREMENTS, UNBUILDABLE_DEPS,
} from '../server/src/lib/generatedAppCheck.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'server', 'test-fixtures', 'runnable-app');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

// The fixture as the generator would hand it over: a flat list of { path, content }.
function readFixture() {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(join(dir, e.name));
    return [join(dir, e.name)];
  });
  return walk(FIXTURE).map((p) => ({ path: relative(FIXTURE, p), content: readFileSync(p, 'utf8') }));
}

const good = readFixture();
const clone = () => good.map((f) => ({ ...f }));
const setFile = (files, path, content) => files.map((f) => (f.path === path ? { ...f, content } : f));
const addFile = (files, path, content) => [...files, { path, content }];

console.log('\n1. the fixture is a real app, and it is accepted');
check('the fixture ships an entry point', existsSync(join(FIXTURE, 'server', 'index.js')), true);
check('…and a database module', existsSync(join(FIXTURE, 'server', 'db.js')), true);
check('a good app produces NO problems', generatedAppProblems(good), []);
// The other direction. A checker that flags everything would pass every rejection test below and be
// useless, so this asserts it can say yes before it is trusted to say no.
check('…and every runnable-app requirement is satisfied by it', RUNNABLE_APP_REQUIREMENTS.map((r) => r.verify(good, packageJsonOf(good))).join(','), RUNNABLE_APP_REQUIREMENTS.map(() => 'true').join(','));

console.log('\n2. defect 1, as actually produced: a dependency that cannot install');
// Exactly the observed failure: the generated package.json declared better-sqlite3.
// Written the long way on purpose: the first version called setFile(files, PATH, json) with the path as
// the CONTENT argument, so nothing was actually changed and three checks passed for the wrong reason.
const goodPkg = JSON.parse(good.find((f) => f.path === 'package.json').content);
const withBadDep = JSON.stringify({ ...goodPkg, dependencies: { ...goodPkg.dependencies, 'better-sqlite3': '^11.0.0' } }, null, 2);
const badDep = setFile(clone(), 'package.json', withBadDep);
check('the defect-1 fixture really did change the manifest',
  Boolean(packageJsonOf(badDep)?.data?.dependencies?.['better-sqlite3']), true);
const depProblems = dependencyProblems(packageJsonOf(badDep));
// `find`, not `[0]`: the fixture legitimately also carries sqlite3, and asserting on the first element
// made this read as "sqlite3 is unbuildable" — which is exactly the false positive the list had.
const unbuildable = depProblems.find((p) => p.kind === 'unbuildable');
check('the unbuildable dependency is rejected', Boolean(unbuildable), true);
check('…and named', unbuildable?.package, 'better-sqlite3');
check('…with the measured reason, not a guess', /prebuilt binary/.test(unbuildable?.detail || ''), true);
check('…and it points at the package that works', /use sqlite3/.test(unbuildable?.detail || ''), true);
// sqlite3 is native but PREBUILT for this Node, so it must NOT be reported — measured, not assumed.
check('a native addon with a prebuilt binary is not reported', depProblems.some((p) => p.package === 'sqlite3'), false);
check('the measured defect is the one recorded in the table', Object.keys(UNBUILDABLE_DEPS), ['better-sqlite3']);
check('a native-build dependency is reported too, since a clean machine has no toolchain',
  dependencyProblems(packageJsonOf(setFile(clone(), 'package.json', JSON.stringify({ dependencies: { bcrypt: '^5' } })))).map((p) => p.kind), ['needs-compiler']);
check('a pure-JS dependency set is left alone',
  dependencyProblems(packageJsonOf(setFile(clone(), 'package.json', JSON.stringify({ dependencies: { express: '^4', dotenv: '^16' } })))), []);

console.log('\n3. defect 2, as actually produced: the module contract');
// `db.prepare(...)` on a module that exports a factory — the exact shape of the generated routes file.
const badContract = setFile(clone(), 'server/routes/tasks.js',
  "const express = require('express');\nconst db = require('../db');\nconst router = express.Router();\nrouter.get('/', (req, res) => {\n  const tasks = db.prepare('SELECT id FROM tasks').all();\n  res.json({ tasks });\n});\nmodule.exports = router;\n");
const contractProblems = moduleContractProblems(badContract);
check('calling the module as if it were the handle is rejected', contractProblems.map((p) => p.kind), ['module-contract']);
check('…naming the file that breaks', contractProblems[0]?.file, 'server/routes/tasks.js');
check('…and the call it made', /db\.prepare\(\)/.test(contractProblems[0]?.detail || ''), true);
check('…and saying what to do instead', /call getDb\(\)/.test(contractProblems[0]?.detail || ''), true);
check('the GOOD fixture is not flagged for the same call through getDb()', moduleContractProblems(good), []);
// The prose trap, which caught the checker itself: the fixture's own comment quotes the bad call.
check('a comment that quotes the bad call is not a defect',
  moduleContractProblems(setFile(clone(), 'server/routes/tasks.js',
    "const db = require('../db');\n// never call db.prepare() on the module — use db.getDb()\nmodule.exports = {};\n")), []);
check('withoutComments really strips them', withoutComments('a // db.prepare()\nb /* db.query() */ c'), 'a \nb  c');

console.log('\n4. the entry point the README tells you to run must exist');
check('a start script pointing at a missing file is rejected',
  entryPointProblems(clone(), { data: { scripts: { start: 'node server/index.js' } } }).length, 0);
check('…and one pointing at a file that does not ship is reported',
  entryPointProblems(clone(), { data: { scripts: { start: 'node server/missing.js' } } }).map((p) => p.kind), ['missing-entry']);
check('no start script at all is reported, because the README gives one',
  entryPointProblems(clone(), { data: { scripts: {} } }).map((p) => p.kind), ['no-start-script']);
check('package.json is found wherever it sits', packageJsonOf(good)?.path, 'package.json');
check('dependencies are read from both blocks', declaredDependencies({ dependencies: { a: '1' }, devDependencies: { b: '2' } }).sort().join(','), 'a,b');
check('a broken package.json is not a crash', packageJsonOf([{ path: 'package.json', content: '{not json' }]), null);

console.log('\n5. the checklist is complete, and each item can fail');
check('it covers the six things a runnable app needs', RUNNABLE_APP_REQUIREMENTS.length, 6);
for (const req of RUNNABLE_APP_REQUIREMENTS) {
  check(`${req.id}: the good fixture passes it`, req.verify(good, packageJsonOf(good)), true);
}
// Each item must be able to FAIL, or it is decoration. Empty file lists except where the item is about
// persistence, which legitimately only needs one file.
const empties = { 'package-json': [], 'start-script': [], 'installable-deps': good, 'persistent-store': [{ path: 'x.txt', content: 'nothing' }], 'gitignore-secrets': [], 'readme-one-command': [] };
for (const req of RUNNABLE_APP_REQUIREMENTS) {
  const target = req.id === 'installable-deps' ? badDep : (empties[req.id] || []);
  check(`${req.id}: fails when its subject is missing`, req.verify(target, packageJsonOf(target)), false);
}

console.log('\n6. the two defects would have stopped the build');
// The end-to-end point, stated as one assertion per defect: what shipped on 2026-09-29 is caught by this.
check('a generated app with defect 1 is rejected overall', generatedAppProblems(badDep).some((p) => p.kind === 'unbuildable'), true);
check('a generated app with defect 2 is rejected overall', generatedAppProblems(badContract).some((p) => p.kind === 'module-contract'), true);
check('…and both at once are both reported', generatedAppProblems(setFile(badDep, 'server/routes/tasks.js', badContract.find((f) => f.path === 'server/routes/tasks.js').content)).map((p) => p.kind).sort().join(','), 'module-contract,unbuildable');

console.log('\n7. the route reaching the generator is asked for the same thing');
// `generateBackend`'s brief and this checker are two halves of one promise; if the brief stops asking for
// a one-command app, the checker starts rejecting everything and nobody knows why.
const gen = readFileSync(join(ROOT, 'server', 'src', 'functions', 'generateBackend.js'), 'utf8');
check('the generator still asks for one command', /ONE command must start everything/.test(
  readFileSync(join(ROOT, 'server', 'src', 'lib', 'infrastructureComponents.js'), 'utf8')), true);
check('…and injects that requirement into the brief', gen.includes('${runnableRequirement}'), true);

// ── Is the checker applied WHERE THE APP IS MADE, or only in this fixture? ─────────────────────────────────
//
// ⚠️ THE HOLE THIS CLOSES WAS A COMMENT. `src/lib/exportPromise.js` stated that `generatedAppCheck.js`
// "runs where the app is made" — and nothing under `server/src/functions` or `server/src/routes` imported it.
// It ran in this CI fixture and nowhere else, so a build could go green over an app that cannot install or
// start, and the operator found out at download. Every assertion above passes in that world.
//
// The lesson is the same one this repo keeps relearning: a check that is never CALLED reads exactly like a
// check that passed. So these assert the CALL, not the checker's existence.
console.log('\n6. the checker runs in the build loop, not only here');
const chat = readFileSync(join(ROOT, 'server', 'src', 'functions', 'chatWithMorpheus.js'), 'utf8');
const reviewer = readFileSync(join(ROOT, 'server', 'src', 'lib', 'reviewer.js'), 'utf8');
const promise = readFileSync(join(ROOT, 'src', 'lib', 'exportPromise.js'), 'utf8');

check('the build loop appends the section to the reviewer\'s context',
  /reviewContext \+= runnableAppBlock\(fileOps\)/.test(chat), true);
// BEHAVIOUR, on the real fixture — not the handler's text. The fixture is a good app; the two defects below are
// the ones actually produced on 2026-09-29, so the composition is exercised with the real thing.
const { runnableAppBlock } = await import('../server/src/lib/reviewContext.js');
check('a good app produces no section at all', runnableAppBlock(good), '');
const unbuildableBlock = runnableAppBlock(badDep);
check('an unbuildable dependency reaches the reviewer, named', /better-sqlite3/.test(unbuildableBlock), true);
check('…and it names the block the prompt is told to look for', /^\n\nRUNNABLE APP — mechanical findings/.test(unbuildableBlock), true);
check('…and says a non-applicable finding must not be reported', /must not be reported/.test(unbuildableBlock), true);
check('…and the machine-readable kind travels with it', /\[unbuildable\]/.test(unbuildableBlock), true);
const brokenModule = setFile(clone(), 'server/routes/tasks.js', 'const db = require("../db");\nrouter.get("/", (req, res) => { db.prepare("select 1"); });\n');
check('a broken module contract reaches the reviewer too', /module-contract/.test(runnableAppBlock(brokenModule)), true);
check('…with the file it is about', /tasks\.js: /.test(runnableAppBlock(brokenModule)), true);
// Only when there is something to say — a section that is always present is one the reviewer skims.
check('a clean build adds nothing', runnableAppBlock(good.map((f) => ({ path: f.path, content: f.content }))), '');
// The reviewer must be told what to DO with it, or the section is decoration in a prompt.
check('the reviewer prompt has a rule for the block', /- RUNNABLE APP: if the context includes a "RUNNABLE APP" section/.test(reviewer), true);
check('…and it says a non-applicable finding must not be reported', /A finding that does not apply to this app[\s\S]{0,120}must not report it/.test(reviewer), true);
// ONE producer. The text moved out of the handler and into reviewContext.js when this became a testable
// function; the count is asserted where the text lives, and the handler must not grow its own copy.
const reviewCtx = readFileSync(join(ROOT, 'server', 'src', 'lib', 'reviewContext.js'), 'utf8');
check('the block text is built in exactly one place', (reviewCtx.match(/RUNNABLE APP — mechanical findings/g) || []).length, 1);
check('…and the handler does not keep a second copy', (chat.match(/RUNNABLE APP — mechanical findings/g) || []).length, 0);
check('…and a dependency finding names the package, not just the reason', /p\.package \?/.test(reviewCtx), true);
// THE FALSE COMMENT MUST NOT COME BACK — it is the thing that hid this, and it is the kind of sentence that is
// re-added by the next person who assumes rather than greps.
check('the export path no longer claims the checker runs where the app is made',
  /it runs where the app is made/.test(promise), false);

// ── The BROWSER tier: does a real browser find the page visible? ────────────────────────────────────────────
//
// Everything above is HTTP and source-reading. This repo spent a day learning why that is not enough — a bundle
// check passes and an HTTP 200 says only that a shell was served, while the page is blank or the console throws
// (MORPHEUS-BIG-PICTURE.md, "Self-dev should render what it builds").
console.log('\n7. the rendered page is checked, in a browser, ADVISORILY');

check('the fixture serves a page at all (there is something to render)',
  /data-page="fixture-home"/.test(readFileSync(join(ROOT, 'server', 'test-fixtures', 'runnable-app', 'server', 'index.js'), 'utf8')), true);

const smoke = readFileSync(join(ROOT, 'scripts', 'smoke-generated-app.mjs'), 'utf8');
const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const required = readFileSync(join(ROOT, 'server', 'src', 'lib', 'engine', 'requiredChecks.js'), 'utf8');

// VISIBILITY, not presence. Content that exists in the DOM and cannot be seen is the exact failure this tier was
// added for, and `isVisible()` is the whole difference from an HTTP probe or a text read — verified by hiding the
// heading with `display:none` and watching ONLY this assertion go red while the HTTP checks stayed green.
check('…and the browser asserts the content is VISIBLE, not merely present', /\.isVisible\(\)/.test(smoke), true);
check('…the row the API created is on the screen', /locator\('\[data-task\]'\)/.test(smoke), true);
// Both halves of the console discipline, copied from the required `render` job: filtering the message alone would
// hide a genuinely broken same-origin asset, because Chrome's text does not always name the URL.
check('…and a same-origin 4xx/5xx is caught from the RESPONSE side, not just the console text',
  /badResponses/.test(smoke) && /res\.url\(\)\.startsWith\(BASE\)/.test(smoke), true);

// ⚠️ THE ADVISORY DECISION, AS AN ASSERTION. This script runs inside the REQUIRED `render` job, so a browser pass
// added unconditionally would gate every self-dev merge on a browser job — and one flake would stop all of them.
// The tier is opt-in and lives only in the advisory job; promoting it is a deliberate two-file change.
check('the required job runs the script WITHOUT the browser tier', /run: node scripts\/smoke-generated-app\.mjs$/m.test(ci), true);
check('…the browser tier is opt-in behind --render', /process\.argv\.includes\('--render'\)/.test(smoke), true);
check('…and a separate job runs it with the tier', /run: node scripts\/smoke-generated-app\.mjs --render/.test(ci), true);
check('…whose job name says it is advisory', /name: render-generated-app \(advisory\)/.test(ci), true);
// The claim that matters most: it must NOT be in the required list, or the advisory landing was a fiction.
check('…and it is NOT a required gate', /SELF_DEV_REQUIRED_CHECKS = \[[^\]]*'render-generated-app/.test(required), false);
check('…while the gates it must not disturb are still required',
  /SELF_DEV_REQUIRED_CHECKS = \['guards \(no install\)', 'lint \+ build', 'render'\]/.test(required), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ we could ship an app the operator cannot start or cannot see\n');
  process.exit(1);
}
console.log('a generated app is checked for the two ways it was measured to fail before it is shipped\n');
