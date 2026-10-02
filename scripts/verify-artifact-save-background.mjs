// The compiled-artifact SAVE runs off the HTTP request, and a save that fails
// can never read as a build that failed.
//
// WHY THIS EXISTS (2026-10-02, the WikiData Batch Uploader's macOS build)
//
// The build SUCCEEDED. Release v36970869714 published app-macos-apple-silicon.dmg
// (103,456,328 bytes), app-macos-intel.dmg (113,581,692 bytes) and
// USER-MANUAL.txt (25,553 bytes). The save downloaded ~217 MB from GitHub and
// re-uploaded every byte into Morpheus storage, sequentially, inside ONE request.
// The browser's own timeout is 210s (src/api/base44Client.js API_FETCH_TIMEOUT_MS)
// but Cloudflare's proxy read timeout is ~100s, so the edge cut the connection
// first and the client's own message never appeared. The UI reported:
//
//   "Build succeeded but the compiled app couldn't be saved to your files:
//    NetworkError when attempting to fetch resource."
//
// and told the operator to tap RECOMPILE — to spend credits rebuilding an app
// that already existed and was already downloadable.
//
// Two independent claims, both asserted here:
//   1. the save is a background job with a polled status and real per-asset
//      progress, that survives a page reload; and
//   2. a failed or slow save is a SAVE problem — never a build failure, and never
//      a reason to rebuild.
//
// Dependency-light: the only import is the pure server/src/lib/artifactSaveJob.js
// (itself importing only the pure artifactSaveOutcome.js), so this runs in CI's
// no-install guards job.
//
// Run:  node scripts/verify-artifact-save-background.mjs
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createArtifactSaveRecord, markArtifactSaving, markArtifactSaved, markArtifactFailed,
  finishArtifactSaveRecord, artifactSaveStatusView, artifactSaveResponse,
  ARTIFACT_SAVE_STALE_MS,
} from '../server/src/lib/artifactSaveJob.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** Strip comments before matching source, so a guard is never satisfied by prose (H19). */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

console.log('\nArtifact save — background job + honest failure\n');

// ═══ 1. the pure state machine ═══════════════════════════════════════════════
console.log('1. the job state machine says what actually happened');
const assets = [
  { name: 'app-macos-apple-silicon.dmg', path: '_compiled/app-macos-apple-silicon.dmg' },
  { name: 'app-macos-intel.dmg', path: '_compiled/app-macos-intel.dmg' },
  { name: 'USER-MANUAL.txt', path: '_compiled/USER-MANUAL.txt' },
];
const record = createArtifactSaveRecord({
  projectId: 'p1', userId: 'u1', repoFullName: 'me/build', target: 'mac-app',
  releaseTag: 'v36970869714', assets, now: 1000,
});
check('a fresh record is saving with the release\'s full asset count', 
  { phase: record.phase, total: record.assets.length, saved: record.artifacts.length }, { phase: 'saving', total: 3, saved: 0 });

markArtifactSaving(record, assets[0].name, 1100);
markArtifactSaved(record, { path: assets[0].path, url: '/uploads/a', name: assets[0].name, size: 103456328 }, 1200);
markArtifactSaved(record, { path: assets[1].path, url: '/uploads/b', name: assets[1].name, size: 113581692 }, 1300);
markArtifactFailed(record, assets[2].name, 'HTTP 404', 1400);
finishArtifactSaveRecord(record, { now: 1500 });
check('two of three landing with one failure is a PARTIAL save', record.phase, 'partial');
check('the failed asset keeps its name', record.failed, ['USER-MANUAL.txt']);
check('the failure detail is kept for the logs', record.errors, ['USER-MANUAL.txt: HTTP 404']);

const allOk = createArtifactSaveRecord({ projectId: 'p2', userId: 'u1', assets: [assets[0]], now: 1 });
markArtifactSaved(allOk, { path: assets[0].path, name: assets[0].name }, 2);
finishArtifactSaveRecord(allOk, { now: 3 });
check('every asset landing is DONE', allOk.phase, 'done');

const none = createArtifactSaveRecord({ projectId: 'p3', userId: 'u1', assets: [assets[0]], now: 1 });
markArtifactFailed(none, assets[0].name, 'HTTP 500', 2);
finishArtifactSaveRecord(none, { fatalError: 'Failed to download any artifacts. app: HTTP 500', now: 3 });
check('nothing landing is FAILED, never a partial success', none.phase, 'failed');

// ═══ 2. the poll is rebuilt from durable evidence ═══════════════════════════
console.log('\n2. a poll reconstructs from the rows on disk, not from memory');
const rows = [
  { path: assets[0].path, file_url: '/uploads/a', content: '// Build: v36970869714\n// Size: 98.7 MB' },
  { path: assets[1].path, file_url: '/uploads/b', content: '// Build: v36970869714\n// Size: 108.3 MB' },
];
const rebuilt = artifactSaveStatusView({ record: null, savedRows: rows, now: 5000 });
check('with no live record, the saved rows ARE the state', rebuilt.phase, 'done');
check('…and their download links survive', rebuilt.artifacts.map((a) => a.url), ['/uploads/a', '/uploads/b']);
check('…with the release tag read back from the row', rebuilt.releaseTag, 'v36970869714');
check('nothing saved and nothing recorded is idle, not failed',
  artifactSaveStatusView({ record: null, savedRows: [], now: 1 }).phase, 'idle');

// The resume hazard: a recompile produces the same filenames. A row from the
// PREVIOUS release must not be counted as this save's progress.
const resumed = createArtifactSaveRecord({ projectId: 'p4', userId: 'u1', releaseTag: 'vNEW', assets, now: 10 });
const staleRows = [{ path: assets[0].path, file_url: '/uploads/old', content: '// Build: vOLD' }];
const duringResume = artifactSaveStatusView({ record: resumed, savedRows: staleRows, now: 20 });
check('a row from a previous release does NOT count as this save\'s progress', duringResume.saved, 0);
check('…while a row for the same release does',
  artifactSaveStatusView({
    record: resumed,
    savedRows: [{ path: assets[0].path, file_url: '/uploads/a', content: '// Build: vNEW' }],
    now: 20,
  }).saved, 1);

// ═══ 3. a slow or dead process is not reported as still saving ══════════════
console.log('\n3. a "saving" record cannot report progress forever');
const wedged = createArtifactSaveRecord({ projectId: 'p5', userId: 'u1', assets, now: 0 });
const fresh = artifactSaveStatusView({ record: wedged, savedRows: [], now: ARTIFACT_SAVE_STALE_MS - 1 });
check('a recently-touched record is saving', fresh.phase, 'saving');
check('…and is flagged active so the panel keeps polling', fresh.active, true);
const dead = artifactSaveStatusView({ record: wedged, savedRows: [], now: ARTIFACT_SAVE_STALE_MS + 1 });
check('a record untouched past the bound is INTERRUPTED, not saving', dead.phase, 'interrupted');
check('…and not active, so the poll stops', dead.active, false);
check('…and it is never called done', dead.phase === 'done', false);

// ═══ 4. a failed save never reads as a failed build ═════════════════════════
console.log('\n4. the panel and the email keep a save failure separate from the build');
const panelRaw = read('src/components/matrix/CompilePanel.jsx');
const panel = stripComments(panelRaw);
check('the panel has a save-specific phase', /setPhase\('save-failed'\)/.test(panel), true);
check('the old "couldn\'t be saved … Tap RECOMPILE" wording is gone',
  /Tap RECOMPILE to retry/.test(panel), false);
check('…and the exact incident sentence is gone',
  /Build succeeded but the compiled app couldn't be saved/.test(panel), false);
check('a failed start is a save problem, not an error phase',
  /catch \(e\) \{[\s\S]{0,900}setPhase\('save-failed'\)/.test(panel), true);

// The save-failed BLOCK itself: it must say the build succeeded, offer the
// GitHub release links, and never offer a rebuild.
const sfStart = panel.indexOf("{phase === 'save-failed' && (");
const sfEnd = panel.indexOf("{phase === 'error' && (", sfStart);
check('the save-failed block exists and is its own region', sfStart > -1 && sfEnd > sfStart, true);
const saveBlock = sfStart > -1 && sfEnd > sfStart ? panel.slice(sfStart, sfEnd) : '';
check('it says the BUILD SUCCEEDED', /BUILD SUCCEEDED/.test(saveBlock), true);
check('…and never says BUILD FAILED', /BUILD FAILED/.test(saveBlock), false);
check('…it points at the GitHub release downloads', /status\?\.assets\?\.map\(/.test(saveBlock), true);
check('…it never offers RECOMPILE', /RECOMPILE/.test(saveBlock), false);

const mailRaw = read('server/src/functions/sendCompileCompleteEmail.js');
check("the email has a 'save_failed' result", /'save_failed'/.test(mailRaw), true);
check('a save failure is not the "needs attention" subject',
  /save_failed'[\s\S]{0,200}built, but the app could not be saved/.test(mailRaw), true);
check('the save_failed email says the build succeeded',
  /build for "\$\{projectName\}" succeeded\./.test(mailRaw), true);
check('the partial email no longer tells the user to rebuild',
  /tap RECOMPILE to retry the rest/.test(mailRaw), false);

// ═══ 5. the save does not hold the request open ═════════════════════════════
console.log('\n5. the heavy work is detached from the request');
const saveRaw = read('server/src/functions/saveCompiledArtifacts.js');
const save = stripComments(saveRaw);
check('the download→upload loop is a separate async function', /async function runArtifactSave\(/.test(save), true);
check('the handler starts it detached, not awaited', /void runArtifactSave\(/.test(save), true);
check('…and never awaits it', /await runArtifactSave\(/.test(save), false);
check('the per-asset download runs inside the detached runner',
  save.indexOf('await processAsset(') > save.indexOf('async function runArtifactSave(')
  && save.indexOf('await processAsset(') < save.indexOf('export default async function handler('), true);
check('the handler writes no response of its own — a save failure is never an HTTP error',
  /res\.status\(/.test(save), false);
check('the detached runner cannot produce an unhandled rejection',
  /void runArtifactSave\([\s\S]*?\}\)\.catch\(/.test(save) || /try \{[\s\S]*?\} catch \(err\) \{[\s\S]*?save job crashed/.test(save), true);

// ═══ 6. the client polls, with real per-asset progress and reload survival ══
console.log('\n6. the client polls a status endpoint and survives a reload');
const ws = read('src/hooks/useWorkspace.js');
const statusFn = read('server/src/functions/getArtifactSaveStatus.js');
check('the workspace client calls the status endpoint',
  /invoke\('getArtifactSaveStatus'/.test(ws), true);
check('the status endpoint reads the durable `_compiled/` rows',
  /startsWith\('_compiled\/'\)/.test(statusFn) && /readArtifactSaveRecord/.test(statusFn), true);
check('the panel polls the save on its own timer',
  /savePollRef\.current = setInterval\(\(\) => pollSave\(\)/.test(panel), true);
check('the panel shows saved/total progress',
  /SAVED \{saveState\.saved\}\/\{saveState\.total\}/.test(panel), true);
check('…and names the asset currently being copied', /saveState\.currentAsset/.test(panel), true);
check('the panel resumes a running save when it opens (page reload mid-save)',
  /onCheckSave\?\.\(project\.id\)[\s\S]{0,300}data\?\.active[\s\S]{0,200}setPhase\('saving'\)/.test(panel), true);

// ═══ 7. streaming and idempotent resume are preserved ═══════════════════════
console.log('\n7. the save is still streamed, and resuming is safe');
check('artifacts go through the stream upload', /uploadFileStream\(\{ stream,/.test(save), true);
check('…and never through the buffering upload', /uploadFile\(\{/.test(save), false);
check('the row write is an upsert on (project_id, path)',
  /project_id_path/.test(save) && /upsert\(/.test(save), true);
check('an asset already saved for this release is skipped, not re-downloaded',
  /sameRelease && rowPaths\.has\(path\)/.test(save), true);
check('…and the skip is decided by the SAVED row\'s release tag',
  /releaseTagFromRow/.test(save), true);

// ═══ 8. no dependency on the optional queue (H17) ═══════════════════════════
console.log('\n8. the save works with no Redis configured');
for (const rel of ['server/src/functions/saveCompiledArtifacts.js', 'server/src/functions/getArtifactSaveStatus.js', 'server/src/lib/artifactSaveJobStore.js']) {
  const src = read(rel);
  check(`${rel} does not import the optional queue`, /from '[^']*queue\.js'|bullmq/.test(src), false);
}
check('…and does not read REDIS_URL', /REDIS_URL/.test(save), false);

// ═══ 9. the release is the run's own, not "latest" ══════════════════════════
console.log('\n9. the save fetches the run\'s own release when given its tag');
const compileStatus = read('server/src/functions/getCompileStatus.js');
check('getCompileStatus hands the panel the run\'s release tag', /result\.releaseTag = releaseTag/.test(compileStatus), true);
check('the panel passes that tag to the save', /releaseTag: data\.releaseTag/.test(panel), true);
check('the save looks the release up by tag', /releases\/tags\/\$\{releaseTag\}/.test(save), true);
check('…and does not silently fall back to "latest" for a tag that is missing',
  /No release found for \$\{releaseTag\}/.test(save), true);

// ═══ 10. the guard's own fixture is sound (H19) ═════════════════════════════
// A guard whose fixture cannot fire is green for a reason unrelated to its
// subject, so prove the extraction above actually produced a block.
check('the save-failed extraction is non-trivial (fixture sanity)', saveBlock.length > 200, true);
check('…and it is the block containing the build-succeeded heading',
  saveBlock.indexOf('BUILD SUCCEEDED') > -1, true);

// ═══ 11. the handlers exist where the dispatcher looks ══════════════════════
console.log('\n11. the two functions the client invokes exist');
check('saveCompiledArtifacts.js exists', existsSync(join(ROOT, 'server/src/functions/saveCompiledArtifacts.js')), true);
check('getArtifactSaveStatus.js exists', existsSync(join(ROOT, 'server/src/functions/getArtifactSaveStatus.js')), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED\n`);
  process.exit(1);
}
console.log('the save runs in the background, and a failed save is never a failed build\n');
