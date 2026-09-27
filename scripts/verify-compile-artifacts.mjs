// Runtime verification for the compile-artifact save outcome.
//
// Dependency-free — it imports the pure outcome module and reads two sources, so
// it runs in CI's no-install guards job. Run: node scripts/verify-compile-artifacts.mjs
//
// WHY THIS EXISTS (2026-09-27)
//
// saveCompiledArtifacts.js accumulated per-asset failures in an `errors` array
// and then returned only `{ saved, files, artifacts }`. CompilePanel.jsx tests
// only `saveResult?.error`, so a glob target — rpi-distro / linux-distro release
// the image, the flasher and the READMEs — whose `.img.gz` failed while one
// small asset saved, produced "Build complete!" and handed the user a README
// with no image. The claim was in the code for a while before anything tested
// it, and a returned object can be correct while the UI still ignores it — so
// this asserts the pure decision AND the wiring on both sides of the boundary.
import { readFileSync } from 'node:fs';
import { summarizeArtifactSave } from '../server/src/lib/artifactSaveOutcome.js';

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

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

console.log('\nCompile-artifact save — runtime verification\n');

console.log('1. every asset saved — the honest path keeps its exact old shape');
const all = summarizeArtifactSave({
  savedPaths: ['_compiled/app.apk'],
  artifacts: [{ path: '_compiled/app.apk', name: 'app.apk' }],
});
check('all-saved is exactly { saved, files, artifacts }', all, {
  saved: 1,
  files: ['_compiled/app.apk'],
  artifacts: [{ path: '_compiled/app.apk', name: 'app.apk' }],
});
check('…and carries no partial/failed/errors keys',
  ['partial', 'failed', 'errors'].filter((k) => k in all), []);
check('an empty release with no failures is a zero save, not a partial one',
  summarizeArtifactSave({ savedPaths: [] }), { saved: 0, files: [], artifacts: [] });

console.log('\n2. one asset failed — the failure travels and the landed files stay');
// The real shape: a distro release is the image + the flasher + the README, and
// the image is the one that actually matters.
const partial = summarizeArtifactSave({
  savedPaths: ['_compiled/flash.sh', '_compiled/README.txt'],
  artifacts: [{ name: 'flash.sh' }, { name: 'README.txt' }],
  failed: ['morpheus-os.img.gz'],
  errors: ['morpheus-os.img.gz: S3 PutObject failed: 503 SlowDown'],
});
check('the assets that landed are kept', partial.files, ['_compiled/flash.sh', '_compiled/README.txt']);
check('their download records are kept', partial.artifacts, [{ name: 'flash.sh' }, { name: 'README.txt' }]);
check('saved counts only what landed', partial.saved, 2);
check('partial is set so no caller can read it as complete', partial.partial, true);
check('the missing asset is named', partial.failed, ['morpheus-os.img.gz']);
check('the failure detail is preserved for the logs', partial.errors.length, 1);
check('the detail names the same asset', /^morpheus-os\.img\.gz: /.test(partial.errors[0]), true);

console.log('\n3. several failures keep their order and count');
const many = summarizeArtifactSave({
  savedPaths: ['_compiled/README.txt'],
  artifacts: [{ name: 'README.txt' }],
  failed: ['morpheus-os.img.gz', 'flash.sh'],
  errors: ['morpheus-os.img.gz: timeout', 'flash.sh: 404'],
});
check('every failed asset is named, in release order', many.failed, ['morpheus-os.img.gz', 'flash.sh']);
check('saved is the landed count, not the attempted count', many.saved, 1);

console.log('\n4. the handler cannot drop the failures again');
const handler = read('../server/src/functions/saveCompiledArtifacts.js');
check('it records each failed asset name', /failed\.push\(name\)/.test(handler), true);
check('it returns the outcome helper rather than a bare literal',
  /return summarizeArtifactSave\(/.test(handler), true);
check('it passes the failures into it', /failed, errors \}\)/.test(handler), true);
check('a save where nothing landed is still a hard 500, not a "partial" success',
  /saved\.length === 0/.test(handler) && /res\.status\(500\)/.test(handler), true);
check('the all-saved short-circuit still returns files + artifacts',
  /return \{\s*saved: alreadySaved\.length/.test(handler) || /alreadyExists: true/.test(handler), true);

console.log('\n5. the UI cannot read a partial save as "Build complete"');
const panel = read('../src/components/matrix/CompilePanel.jsx');
check('the panel reads the failures off the save result',
  /saveResult\?\.partial/.test(panel) && /saveResult\.failed/.test(panel), true);
check('the done phase branches on them', /saveFailures\.length > 0/.test(panel), true);
check('the missing files are named on screen', /saveFailures\.map\(/.test(panel), true);
check('a partial save does NOT send the success notification',
  /if \(!saveWasPartial\) notifyComplete\('success'/.test(panel), true);
check('a partial save sends its own notification', /notifyComplete\('partial'/.test(panel), true);
check('the partial heading is not the success heading',
  /DID NOT SAVE/.test(panel) && /Build complete!/.test(panel), true);
// The wiring that matters: the failure block is a branch of the done phase, so
// the success copy cannot render in the same arm. Asserting the two live in
// different arms of one ternary is what makes "it branches" mean something.
check('the success copy sits in the else arm of that branch',
  /saveFailures\.length > 0 \?/.test(panel) && /\) : \(\s*<>\s*<div className="flex items-center gap-2 text-ink text-sm">/.test(panel), true);

console.log('\n6. the completion email has an honest middle state');
const mail = read('../server/src/functions/sendCompileCompleteEmail.js');
check("it accepts a 'partial' result", /'partial'/.test(mail), true);
check('a partial email is not the success subject', /⚠ Morpheus/.test(mail), true);
check('a partial email still tells the user the build succeeded',
  /succeeded, but not every compiled file was saved/.test(mail), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED\n`);
  process.exit(1);
}
console.log('all good\n');
