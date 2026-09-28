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
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { summarizeArtifactSave } from '../server/src/lib/artifactSaveOutcome.js';
import { webApp } from '../server/src/lib/compile-targets/web-app.js';

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

console.log('\nthe web-app archive holds the SITE, not the folder containing it');
// Found 2026-09-28 by reading the chain before its first real run. The packaging step was
// `zip -r release.zip dist`, which stores `dist/index.html` — so the archive's root is a
// directory, and the hosting provider serves the archive AS the site root. A deploy would
// have reported success and produced a site whose / served nothing. The fix zips the
// CONTENTS; this calls the adapter for real rather than grepping it, because the shell is
// generated and a guard on the source text would pass on a regenerated wrong command.
const pkgStep = webApp.buildSteps([
  { path: 'package.json', content: JSON.stringify({ scripts: { build: 'vite build' }, dependencies: { react: '18' } }) },
]).find((s) => s.name === 'Package web app');
check('the packaging step exists', Boolean(pkgStep), true);
const shell = pkgStep?.run || '';
// Judge the COMMANDS only — the step carries a comment explaining the old bug, and a guard
// that reads its own explanation as the bug is one that fails on the fix.
const commands = shell.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).join('\n');
check('it zips the CONTENTS of the build output', commands.includes('zip -r "$ROOT/release.zip" .'), true);
check('…from inside that directory', /\(cd "?[^" )]+"? && zip -r "\$ROOT\/release\.zip" \./.test(commands), true);
check('…and never archives the directory itself', /zip -r release\.zip (dist|build)\b/.test(commands), false);
check('the no-build-output fallback still zips the project', commands.includes('zip -r release.zip . -x'), true);
check('a missing archive still fails the run', commands.includes('No web build output found'), true);
// The SPA fallback is scaffolded at the PROJECT root but published from the BUILD output, so
// without this it never reached the archive — the homepage worked and every direct deep link
// 404'd. Same root cause as the nesting bug: project root confused with publish root.
check('the SPA fallback is carried into the published root',
  commands.includes('cp "$ROOT/_redirects" "$OUT/_redirects"'), true);
check('…without overwriting one the build produced itself',
  commands.includes('[ ! -f "$OUT/_redirects" ]'), true);

// And RUN it. The shell is generated, so the only proof the ARCHIVE is right is the archive:
// a guard that reads the command text passes on a command that reads correctly and packs wrong.
const dir = mkdtempSync(join(tmpdir(), 'morpheus-pkg-'));
try {
  mkdirSync(join(dir, 'dist', 'assets'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'index.html'), '<html></html>');
  writeFileSync(join(dir, 'dist', 'assets', 'app.css'), 'body{}');
  writeFileSync(join(dir, '_redirects'), '/*    /index.html   200\n');
  writeFileSync(join(dir, 'package.json'), '{}');
  const script = join(dir, 'package.sh');
  writeFileSync(script, shell + '\n');
  const ran = spawnSync('bash', [script], { cwd: dir, encoding: 'utf8' });
  check('the generated packaging shell runs', ran.status, 0);
  const listed = spawnSync('unzip', ['-Z1', 'release.zip'], { cwd: dir, encoding: 'utf8' });
  const names = String(listed.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  check('the archive holds index.html at its ROOT', names.includes('index.html'), true);
  check('…not nested under the output directory', names.includes('dist/index.html'), false);
  check('…and carries the SPA fallback, which the host needs for deep links',
    names.includes('_redirects'), true);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ═══ the no-build fallback publishes the site, never the secrets ════════════
// A static project with no build script takes the fallback branch, which zips the PROJECT ROOT
// because the root IS the site. That root is also where .env lives (dotenv is a normal dependency),
// and this archive is served to the open internet — so an unfiltered fallback publishes the
// operator's secrets at /.env. Run for real: an archive is the only proof.
const fb = mkdtempSync(join(tmpdir(), 'morpheus-fallback-'));
try {
  writeFileSync(join(fb, 'index.html'), '<html>site</html>');
  writeFileSync(join(fb, 'styles.css'), 'body{}');
  writeFileSync(join(fb, 'robots.txt'), 'User-agent: *\n');
  writeFileSync(join(fb, 'package.json'), '{"scripts":{"start":"node server.js"}}');
  writeFileSync(join(fb, '.env'), 'STRIPE_SECRET_KEY=sk_live_not_a_real_key\n');
  writeFileSync(join(fb, '.env.local'), 'OTHER=1\n');
  writeFileSync(join(fb, 'server-key.pem'), 'not a real key\n');
  mkdirSync(join(fb, 'backend'), { recursive: true });
  writeFileSync(join(fb, 'backend', '.plan.json'), '{}');
  mkdirSync(join(fb, '.morpheus'), { recursive: true });
  writeFileSync(join(fb, '.morpheus', 'forms.json'), '{}');
  const fbScript = join(fb, 'package.sh');
  // The fallback branch only: use a project with no dist/build directory.
  writeFileSync(fbScript, commands + '\n');
  const ranFb = spawnSync('bash', [fbScript], { cwd: fb, encoding: 'utf8' });
  check('the fallback branch runs for a project with no build output', ranFb.status, 0);
  const fbList = spawnSync('unzip', ['-Z1', 'release.zip'], { cwd: fb, encoding: 'utf8' });
  const fbNames = String(fbList.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  check('the site itself is published', fbNames.includes('index.html') && fbNames.includes('styles.css'), true);
  check('…robot rules with it', fbNames.includes('robots.txt'), true);
  check('the operator\'s .env is NOT published', fbNames.includes('.env'), false);
  check('…nor .env.local', fbNames.includes('.env.local'), false);
  check('…nor a private key', fbNames.includes('server-key.pem'), false);
  check('…nor the backend plan', fbNames.includes('backend/.plan.json'), false);
  check('…nor platform bookkeeping', fbNames.includes('.morpheus/forms.json'), false);
} finally {
  rmSync(fb, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED\n`);
  process.exit(1);
}
console.log('all good\n');
