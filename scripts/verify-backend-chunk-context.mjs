// Does a backend generation chunk get to see what the previous chunk wrote?
//
// WHY THIS EXISTS. The build pipeline writes self-consistent code because of one structural property:
// before every Coder call it assembles context from the project's CURRENT files, so a later chunk can
// see what an earlier one produced. The backend generator did not — it passed the frontend files and the
// plan, and `generateFilesChunked` asked for `server/db.js` in one call and `server/routes/tasks.js` in
// the next, blind to the first.
//
// That produced, in one real generated backend (2026-09-29):
//
//   server/index.js        const { initializeDatabase } = require('./db');  await initializeDatabase();
//   server/routes/tasks.js const db = require('../db');                    await db.all('SELECT ...');
//   server/index.js        require('./middleware/auth');   // never in the file list
//
// Three files, three beliefs about `db`. No prompt-wording fixes that, because the disagreement was
// never visible to the model. This guard asserts the mechanism that makes it visible, as BEHAVIOUR:
// call the context builder the generator calls, and check what a later chunk is actually told.
//
// Run:  node scripts/verify-backend-chunk-context.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackendChunkContext, normalizeBackendPath, renderPlanAsText, BACKEND_CONTEXT_MAX_BYTES } from '../server/src/lib/backendChunkContext.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

const PLANNED = ['server/index.js', 'server/db.js', 'server/routes/tasks.js', 'server/middleware/auth.js'];
const DB_FILE = { path: 'server/db.js', content: "module.exports = { initializeDatabase, getDb };\n" };

console.log('\n1. a later chunk is shown what an earlier one wrote');
const second = buildBackendChunkContext({
  plannedFiles: PLANNED,
  writtenSoFar: [DB_FILE],
  chunk: ['server/routes/tasks.js'],
});
check('the earlier file\'s content is in the prompt', second.text.includes('module.exports = { initializeDatabase, getDb }'), true);
check('…under a heading that says to match it', /ALREADY WRITTEN BY EARLIER STEPS/.test(second.text), true);
check('…and it is named, so the import path is knowable', second.text.includes('--- server/db.js ---'), true);
check('…and the file records what it showed', second.shown.includes('written'), true);

console.log('\n2. every chunk sees the WHOLE file list, so nothing is invented');
// The `middleware/auth` file above was never generated because nothing told a chunk whether it was
// supposed to exist. The list is cheap and must always be present, even when contents are dropped.
for (const chunk of [['server/db.js'], ['server/routes/tasks.js'], ['server/index.js']]) {
  const built = buildBackendChunkContext({ plannedFiles: PLANNED, writtenSoFar: [], chunk });
  check(`${chunk[0]}: the full list is shown`, PLANNED.every((p) => built.text.includes(p)), true);
}
check('the list is labelled as complete and closed', /do not invent paths outside it/.test(second.text), true);

console.log('\n3. a chunk is NOT shown its own not-yet-written files');
// Asking a model to agree with content it has not produced is how you get an echo of the prompt rather
// than an implementation, and it wastes the budget the earlier files need.
const first = buildBackendChunkContext({
  plannedFiles: PLANNED,
  writtenSoFar: [{ path: 'server/index.js', content: 'FIRST_CHUNK_MARKER' }],
  chunk: ['server/index.js'],
});
check('its own file content is withheld', first.text.includes('FIRST_CHUNK_MARKER'), false);
check('…while still appearing in the list', first.text.includes('server/index.js'), true);
check('…and an earlier file IS shown to it', buildBackendChunkContext({
  plannedFiles: PLANNED,
  writtenSoFar: [{ path: 'server/db.js', content: 'EARLIER' }],
  chunk: ['server/routes/tasks.js'],
}).text.includes('EARLIER'), true);

console.log('\n4. the backend/ prefix cannot hide a file that was already written');
// The generator itself carries a comment about reviewAndRetry returning both `api/routes.js` and
// `backend/api/routes.js`. If the two spellings are different keys, "already written" is missed and the
// model restates the module — the exact drift this exists to stop.
check('the prefix is stripped', normalizeBackendPath('backend/server/db.js'), 'server/db.js');
check('…for a leading ./ too', normalizeBackendPath('./server/db.js'), 'server/db.js');
check('…and a bare path is unchanged', normalizeBackendPath('server/db.js'), 'server/db.js');
const prefixed = buildBackendChunkContext({
  plannedFiles: PLANNED,
  writtenSoFar: [{ path: 'backend/server/db.js', content: 'PREFIXED_MARKER' }],
  chunk: ['server/routes/tasks.js'],
});
check('a file written with the prefix is still shown', prefixed.text.includes('PREFIXED_MARKER'), true);
check('…and the chunk\'s own file is still withheld when it is spelt with the prefix',
  buildBackendChunkContext({ plannedFiles: PLANNED, writtenSoFar: [{ path: 'backend/server/index.js', content: 'X' }], chunk: ['server/index.js'] }).text.includes('X'), false);

console.log('\n5. the app being served is part of the context — the only requirement the backend has');
// Rob, 2026-09-29: the backend should be generated from "the reality of what it needs to do from the app".
// The heading contains a newline ("THE APP THIS BACKEND SERVES (its calls define the contract):"), so a
// regex without the `s` flag cannot match it — the first version of this check therefore "passed" while
// asserting the opposite of what it reads as. Matching the stable fragment instead.
const withApp = buildBackendChunkContext({ plannedFiles: PLANNED, chunk: [], frontendBlock: 'fetch("/api/tasks")', planBlock: '{"tables":[]}' });
check('the app block is present when the app is given', withApp.text.includes('THE APP THIS BACKEND SERVES'), true);
check('…naming its calls as the contract', withApp.text.includes('its calls define the contract'), true);
check('…and without an app block there is no empty heading', second.text.includes('THE APP THIS BACKEND SERVES'), false);
// THE PLAN IS RENDERED AS TEXT, NOT JSON — and this is a fix, not a preference. Putting the plan in as
// `JSON.stringify(...)` while asking for a JSON object back made the model PARROT the first JSON block it
// saw: measured by A/B on one real call, the answer came back as `{"type":"object","properties":{...}}` —
// the schema — instead of any file. So the assertion is now that no JSON block reaches the prompt.
check('the plan reaches the prompt as text', withApp.text.includes('PLAN FOR THIS BACKEND'), true);
check('…with the requirements still in it', withApp.text.includes('/api/tasks') || withApp.text.includes('tasks'), true);
check('…and NO raw JSON, which is what the model echoed back', /\{\s*"tables"/.test(withApp.text), false);
check('…nor any brace at all in the plan section', renderPlanAsText({ database: { tables: [{ name: 'tasks' }] } }).includes('{'), false);
check('a plan given as an object renders the same as one given as a string',
  renderPlanAsText({ summary: 'x' }), renderPlanAsText('{"summary":"x"}'));
check('an unparseable plan string still yields something, not a crash',
  renderPlanAsText('not json at all').includes('not json'), true);
check('an absent plan yields nothing', renderPlanAsText(null), '');
// A file larger than the whole budget: the earlier file is what gets dropped, not the list.
const overBudget = buildBackendChunkContext({
  plannedFiles: ['server/big.js', 'server/routes/tasks.js'],
  writtenSoFar: [{ path: 'server/big.js', content: 'y'.repeat(BACKEND_CONTEXT_MAX_BYTES + 5000) }],
  chunk: ['server/routes/tasks.js'],
});
check('a file too large to fit is dropped rather than overflowing', overBudget.truncated, true);
check('…and the file that did not fit is absent', overBudget.text.includes('yyyy'), false);
check('…while the list of every file survives', overBudget.text.includes('server/big.js'), true);

console.log('\n6. a big backend degrades predictably rather than silently');
const huge = Array.from({ length: 40 }, (_, i) => ({ path: `server/f${i}.js`, content: 'x'.repeat(4000) }));
const bounded = buildBackendChunkContext({ plannedFiles: huge.map((f) => f.path), writtenSoFar: huge, chunk: [] });
check('the budget is respected', bounded.text.length <= BACKEND_CONTEXT_MAX_BYTES + 2000, true);
check('…and truncation is REPORTED, not silent', bounded.truncated, true);
check('…while the file list still survives, because it is unshifted',
  bounded.text.includes('server/f39.js'), true);
check('an empty input produces no crash and no invented content', buildBackendChunkContext({}).text.includes('ALREADY WRITTEN'), false);
check('a written file with no content is shown as empty, not as undefined',
  buildBackendChunkContext({ plannedFiles: ['a.js'], writtenSoFar: [{ path: 'a.js' }], chunk: [] }).text.includes('--- a.js ---'), true);

console.log('\n6b. the prompt does not contain the phrase the model parroted back');
// Measured by A/B on real calls, one variable at a time. The coder instruction used to end
// "Return fileOperations for ONLY this file set", and the model replied with a JSON SCHEMA
// (`{"type":"object","properties":{...}}`) instead of any file:
//
//   plan as JSON + "Return fileOperations"  -> SCHEMA ECHO
//   plan as JSON + "Reply with a single JSON object whose fileOperations array ..."  -> OK
//   no plan      + "Return fileOperations"  -> SCHEMA ECHO
//
// Asking for a named key and then naming it again as the instruction invites a description of it rather
// than a use of it. This asserts the phrase is gone from the prompt BUILDS, comments excluded.
for (const file of ['server/src/functions/generateBackend.js', 'server/src/functions/generateTests.js']) {
  check(`${file} no longer contains the trigger phrase`, /Return fileOperations/.test(code(read(file))), false);
  check(`…and still asks for the object it wants`, /fileOperations/.test(code(read(file))), true);
}
check('the plan is not handed to the model as raw JSON',
  /\{\s*"tables"/.test(buildBackendChunkContext({ plannedFiles: ['a.js'], chunk: [], planBlock: { database: { tables: [{ name: 't' }] } } }).text), false);

console.log('\n7. the generator actually uses it — a builder nobody calls changes nothing');
const gen = code(read('server/src/functions/generateBackend.js'));
check('generateBackend builds the chunk context', /buildBackendChunkContext\(/.test(gen), true);
check('…from the operations generated so far', /writtenSoFar/.test(gen), true);
check('…and passes it into the prompt', /\$\{context\}/.test(read('server/src/functions/generateBackend.js')), true);

console.log('\n8. the shared chunker hands each call what the earlier ones produced');
const chunker = code(read('server/src/lib/chunkedFileGen.js'));
// The builder must receive the accumulated operations, whatever the call is spelled like. The first
// version of this asserted the literal `buildPrompt(chunk, cleanPlanned, fileOps.slice())`, and the
// truncation-recovery refactor (which hoisted the call into a `send(paths)` helper) broke it while the
// BEHAVIOUR was unchanged — asserting a spelling rather than the property. This checks the property.
const thirdArg = /buildPrompt\(\s*paths\s*,\s*cleanPlanned\s*,\s*fileOps\.slice\(\)\s*\)|buildPrompt\(chunk, cleanPlanned, fileOps\.slice\(\)\)/.test(chunker);
check('it passes the accumulated operations as a third argument', thirdArg, true);
// A COPY, not the live array: a builder that mutated it would silently corrupt the next chunk's context.
check('…as a copy, so a builder cannot corrupt the accumulator', /fileOps\.slice\(\)/.test(chunker), true);
check('…and the first call therefore sees an empty list, not undefined',
  /fileOps = \[\]/.test(chunker), true);

console.log('\n9. the backend path now runs the pipeline\'s parser check');
const genRaw = read('server/src/functions/generateBackend.js');
check('it imports checkSyntax', /import \{ checkSyntax \}/.test(genRaw), true);
check('…and runs it over the generated files', /await checkSyntax\(/.test(genRaw), true);
check('…naming the failures rather than swallowing them', /generated backend has \$\{parseErrors\.length\} syntax error/.test(genRaw), true);
check('…and still keeping the files, because a visible partial beats an empty project',
  /else\s*\{|generatedFiles/.test(genRaw), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ a backend could still be generated blind to its own earlier files\n');
  process.exit(1);
}
console.log('every backend chunk sees the app, the whole file list, and the code already written\n');
