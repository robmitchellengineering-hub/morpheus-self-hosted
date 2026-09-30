// Does a failed generation keep the work that succeeded?
//
// WHY THIS EXISTS. `generateBackend` deleted every existing backend file and wrote the new set in ONE
// `createMany` at the very end. Three separate failures on 2026-09-29/30 turned that into a TOTAL loss —
// five successful model calls discarded, the project left with nothing but its plan:
//
//   * a coder chunk hit the token cap and threw (~117 credits);
//   * the coder answered with a JSON schema instead of files;
//   * the reviewer ran twelve times and never converged (~473 credits).
//
// The truncation and the loop are fixed. This guard covers the third leg, which is the one that turned
// each of them from an inconvenience into a write-off: NOTHING was persisted until the whole generation
// finished.
//
// The rules are pure functions over a tiny store interface, so every branch is asserted here with no
// database, no model and no credits — which is the whole point, because the alternative is discovering
// them the way they were discovered.
//
// Run:  node scripts/verify-incremental-persist.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeBackendPath, planWrites, staleBackendPaths, persistIncrementally, removeStale, partialRunNote,
} from '../server/src/lib/incrementalPersist.js';

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

/** A store that records what happened, and can be told to fail on a path. */
function makeStore({ failOn = [] } = {}) {
  const files = new Map();
  const log = [];
  return {
    files, log,
    writeFile: async ({ path, content }) => {
      if (failOn.includes(path)) throw new Error(`disk full for ${path}`);
      files.set(path, content);
      log.push(`write ${path}`);
    },
    deleteByPath: async (path) => {
      if (failOn.includes(path)) throw new Error(`locked ${path}`);
      files.delete(path);
      log.push(`delete ${path}`);
    },
    existingPaths: async () => [...files.keys()],
  };
}

console.log('\n1. paths normalise to ONE form, so the same file is never written twice');
check('a bare path gains the backend prefix', normalizeBackendPath('server/db.js'), 'backend/server/db.js');
check('an already-prefixed path is left alone', normalizeBackendPath('backend/server/db.js'), 'backend/server/db.js');
check('a leading ./ is dropped', normalizeBackendPath('./server/db.js'), 'backend/server/db.js');
check('backslashes are normalised', normalizeBackendPath('server\\db.js'), 'backend/server/db.js');
check('a doubled separator is collapsed', normalizeBackendPath('backend//server/db.js'), 'backend/server/db.js');
check('an empty path is refused rather than stored as "backend/"', normalizeBackendPath(''), '');
check('a missing path is refused', normalizeBackendPath(undefined), '');
// The generator's own comment records the reviewer returning BOTH spellings for one file. Writing both
// would leave which copy wins up to iteration order.
check('both spellings of one file collapse to a single write',
  planWrites([{ path: 'api/routes.js', content: 'a' }, { path: 'backend/api/routes.js', content: 'b' }]).writes.length, 1);
check('…and the LAST one wins, as a filesystem would',
  planWrites([{ path: 'api/routes.js', content: 'a' }, { path: 'backend/api/routes.js', content: 'b' }]).writes[0].content, 'b');

console.log('\n2. a missing content field is coerced, never passed through');
// The exact 2026-09-29 crash: a generated .env.example arrived with no content, `content` is non-nullable,
// and the ONE `createMany` rejected the whole batch — every file lost to one missing field.
check('an absent content becomes an empty string',
  planWrites([{ path: 'backend/.env.example' }]).writes[0].content, '');
check('a null content becomes an empty string',
  planWrites([{ path: 'a.js', content: null }]).writes[0].content, '');
check('a real content is kept verbatim',
  planWrites([{ path: 'a.js', content: 'export const a = 1;' }]).writes[0].content, 'export const a = 1;');
check('an action of delete removes the path from the plan instead of writing it',
  planWrites([{ path: 'a.js', content: 'x', action: 'create' }, { path: 'a.js', action: 'delete' }]).writes.length, 0);
check('a malformed op does not crash the plan', planWrites([null, {}, { path: 42 }]).writes.length, 0);

console.log('\n3. files are written ONE AT A TIME, so a failure keeps the ones before it');
const store = makeStore({ failOn: ['backend/b.js'] });
const batch = await persistIncrementally({
  writes: planWrites([{ path: 'a.js', content: 'A' }, { path: 'b.js', content: 'B' }, { path: 'c.js', content: 'C' }]).writes,
  store,
});
check('the file before the failure is saved', store.files.has('backend/a.js'), true);
check('the file AFTER the failure is still attempted and saved', store.files.has('backend/c.js'), true);
check('…and the failure is reported, not swallowed', batch.failed.map((f) => f.path), ['backend/b.js']);
check('…with the reason', /disk full/.test(batch.failed[0].reason), true);
check('the successful writes are listed', batch.written, ['backend/a.js', 'backend/c.js']);
// A store that throws on the FIRST file must not stop the rest — the point is that a partial result is
// worth keeping.
const allBad = makeStore({ failOn: ['backend/a.js', 'backend/b.js'] });
const none = await persistIncrementally({ writes: planWrites([{ path: 'a.js', content: 'A' }, { path: 'b.js', content: 'B' }]).writes, store: allBad });
check('every file failing still returns a report rather than throwing', none.failed.length, 2);
check('…and nothing is claimed as written', none.written, []);

console.log('\n4. a file that already exists is REPLACED, never deleted first');
// The old order was the worst of both: it removed the previous working backend and only then began
// producing the one that might never arrive. A run that dies halfway must leave the OLD version, not a hole.
const replaceStore = makeStore();
await replaceStore.writeFile({ path: 'backend/server/db.js', content: 'OLD WORKING VERSION' });
await persistIncrementally({ writes: planWrites([{ path: 'server/db.js', content: 'NEW' }]).writes, store: replaceStore });
check('the new content replaced the old', replaceStore.files.get('backend/server/db.js'), 'NEW');
check('…and the store was never asked to delete it', replaceStore.log.includes('delete backend/server/db.js'), false);
check('…so a failure before the replacement would have left the old version intact',
  replaceStore.log.filter((l) => l.startsWith('write')).length >= 2, true);

console.log('\n5. the stale sweep runs LAST and keeps the plan');
const staleStore = makeStore();
for (const p of ['backend/.plan.json', 'backend/server/old.js', 'backend/server/db.js']) await staleStore.writeFile({ path: p, content: 'x' });
const existing = await staleStore.existingPaths();
const stale = staleBackendPaths(existing, ['backend/server/db.js']);
check('a file this run did not produce is stale', stale, ['backend/server/old.js']);
// The plan is an INPUT to the generation, not an output of it — deleting it breaks the next run outright
// ("No backend plan found. Run planning first.").
check('the plan is never stale', stale.includes('backend/.plan.json'), false);
check('a file this run DID produce is not stale', stale.includes('backend/server/db.js'), false);
check('a spelling difference does not make a file look stale',
  staleBackendPaths(['backend/server/db.js'], ['server/db.js']), []);
const swept = await removeStale({ paths: stale, store: staleStore });
check('the stale file is removed', staleStore.files.has('backend/server/old.js'), false);
check('…and the sweep reports what it removed', swept.removed, ['backend/server/old.js']);
check('…while the file this run produced survives', staleStore.files.has('backend/server/db.js'), true);
const sweepFail = await removeStale({ paths: ['backend/x.js'], store: makeStore({ failOn: ['backend/x.js'] }) });
check('a sweep failure is reported, not thrown', sweepFail.failed.length, 1);

console.log('\n6. a partial run says so, in words that name what is missing');
const note = partialRunNote({ written: ['a.js', 'b.js'], failed: [{ path: 'c.js' }], total: 5, reason: 'the reviewer threw' });
check('it counts what was saved', /2 file\(s\) were generated and saved/.test(note), true);
check('…names what could not be saved', /c\.js/.test(note), true);
check('…says how many were never produced', /3 of 5 planned file\(s\) were never produced/.test(note), true);
check('…gives the reason', /the reviewer threw/.test(note), true);
check('…and states plainly that the backend is incomplete', /INCOMPLETE/.test(note), true);
check('…and what to do next', /Ask again to continue/.test(note), true);
check('a complete run produces no note', partialRunNote({ written: ['a.js'], total: 1 }), null);
check('an empty report produces no note rather than an empty sentence', partialRunNote({}), null);

console.log('\n7. the generator actually uses it — rules nobody calls change nothing');
const gen = code(read('server/src/functions/generateBackend.js'));
check('it persists via the incremental store', /persistIncrementally\(/.test(gen), true);
check('it writes as each chunk lands', /onChunk: persistChunk/.test(gen), true);
check('…and the chunker offers that hook', /onChunk = null/.test(code(read('server/src/lib/chunkedFileGen.js'))), true);
check('the reviewer\'s corrected files are written too', /persistChunk\(reviewed\.fileOps/.test(gen), true);
check('the stale sweep is computed, not skipped', /staleBackendPaths\(/.test(gen), true);
check('…and applied through removeStale', /removeStale\(/.test(gen), true);
// THE central change: the all-or-nothing batch write is gone. If `createMany` ever comes back, so does the
// single missing field taking every file with it.
check('the all-or-nothing batch write is GONE', /projectFile\.createMany/.test(gen), false);
check('…and so is the delete-everything-first', /existingBackend[\s\S]{0,200}projectFile\.delete\(/.test(gen), false);
check('a mid-run failure rethrows with what was saved', /wrapped\.savedFiles = saved/.test(gen), true);
check('…and is marked partial', /wrapped\.partial = true/.test(gen), true);
check('the run reports what it did not produce', /missing: plannedFiles/.test(gen), true);

console.log('\n7b. nothing else writes the backend in one all-or-nothing batch');
// The rule is only load-bearing if every path obeys it. `createMany` is what turned one missing field into
// the loss of every file, so its absence is asserted across the backend-writing functions rather than just
// the one this change touched.
// NOT "no createMany anywhere" — that was the first version of this check and it was wrong. A batch write
// is correct where the caller has the whole set already and atomicity is the point (`installTemplate`
// clones a template in one action, and it coerces content). The DANGEROUS shape is a batch write that
// passes `content` through uncoerced: `content` is non-nullable, so one model output that omitted it
// rejects the whole batch, which is exactly how nine generated files were lost on 2026-09-29. Assert the
// danger, not the API.
for (const f of ['server/src/functions/generateBackend.js', 'server/src/functions/deployBackend.js', 'server/src/functions/installTemplate.js']) {
  const c = code(read(f));
  const usesBatch = /projectFile\.createMany/.test(c);
  const coerces = /content:\s*(typeof [^?]+\?[^:]+:|[A-Za-z_.\[\]'"]+\s*\|\|\s*['"]{2})/.test(c);
  check(`${f.split('/').pop()}: a batch write, if any, coerces missing content`,
    usesBatch ? coerces : true, true);
}

console.log('\n8. a provider failure reports the PROVIDER\'S error, not a reference error');
// Found by forcing a provider failure in a harness. `recordUsageEvent` is called from the catch with
// `model: resolvedModel`, but `resolvedModel` is declared INSIDE the try from the response — so in the
// catch it is in its temporal dead zone, and the reference error replaced the real one. Every provider
// error in the product reported "Cannot access 'resolvedModel' before initialization" instead of
// "AI endpoint error (500)". The comment right above it promised the opposite.
// Find the PROVIDER catch by its own content — the first `} catch (err) {` in the file is a different one,
// and slicing from it inspected the wrong region entirely while the code was correct. Locate the block that
// records a failed usage event.
const ai = code(read('server/src/ai.js'));
const catchStarts = [...ai.matchAll(/\} catch \(err\) \{/g)].map((m) => m.index);
let catchBlock = '';
for (const start of catchStarts) {
  const end = ai.indexOf('throw err;', start);
  const block = ai.slice(start, end > -1 ? end + 10 : start + 500);
  if (/status: 'error'/.test(block)) { catchBlock = block; break; }
}
check('the provider catch block was located at all', catchBlock.length > 0, true);
check('the error recorder does not reference a variable declared after the catch',
  /model: resolvedModel/.test(catchBlock), false);
check('…it uses the request\'s own model, which nothing has renamed yet',
  /model: model\b|\bmodel, isExempt/.test(catchBlock), true);
check('…and the real error is still what the caller gets', /throw err;/.test(ai), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ a failed generation could still discard every file it had already produced\n');
  process.exit(1);
}
console.log('generated files are saved as they are produced, replaced rather than deleted, and a partial run says so\n');
