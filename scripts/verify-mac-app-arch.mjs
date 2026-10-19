// Every Mac this target produces an app for has to be able to OPEN it, and the user has to be able to see
// which download is theirs. Dependency-free (it imports two pure modules), so it runs in CI's no-install
// guards job. Run: node scripts/verify-mac-app-arch.mjs
//
// WHY THIS EXISTS (2026-10-01, Rob: "This app is not suported on this mac", holding a disk image Morpheus
// had just built him). Three separate failures, each invisible to every other gate:
//
//   1. The Python path ran on macos-latest only. PyInstaller compiles for the machine it runs on, so every
//      Python/Qt app came out arm64-only and his Intel Mac refused it. Nothing in the pipeline could tell
//      him that, and there was no Intel build to ask for. The Swift path cross-builds and the Node path
//      ships both binaries, so this is a Python-path property, not a mac-app one.
//   2. The disk image was called app.dmg on every path, so even with two builds the release would have
//      carried two identically-named downloads. `artifactName` made it worse: saveCompiledArtifacts
//      renames the FIRST asset to it, which would have thrown the architecture away on the one file whose
//      filename is the only thing a user can go by.
//   3. The project's own build script often writes a disk image of its own, and the staging step copied
//      dist/ wholesale — so the download was a 103 MB disk image nested inside a 301 MB one, next to the
//      raw --onedir folder that is already inside the .app.
//
// A note on what this guard deliberately does NOT claim: that the resulting app runs. A windowed macOS
// bundle cannot be launched on a headless CI runner, and GitHub's own artifact zip silently discards the
// .app's symlinks (PyInstaller's macOS bundle is full of them; without them QtCore's static initialiser
// calls CFBundleCopyBundleURL(NULL) and the app segfaults before Python starts). That is why the macOS
// artifact travels as a .dmg — which hdiutil builds with symlinks intact — and why "it builds" is not
// evidence that "it opens".
import { macApp, macAppRunners } from '../server/src/lib/compile-targets/mac-app.js';
import { renderWorkflow } from '../server/src/lib/compile-targets/workflow-renderer.js';
import { readFileSync } from 'node:fs';

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

const pythonOwnScript = [
  { path: 'main.py', content: 'print(1)' },
  { path: 'requirements.txt', content: 'PyQt6\n' },
  { path: 'build.py', content: 'print(2)' }
];
const pythonPlain = [
  { path: 'main.py', content: 'print(1)' },
  { path: 'requirements.txt', content: 'PyQt6\n' }
];
const swift = [{ path: 'Package.swift', content: 'x' }, { path: 'Sources/A/main.swift', content: 'x' }];
const node = [{ path: 'package.json', content: '{"bin":{"a":"i.js"}}' }, { path: 'index.js', content: 'x' }];

console.log('\nmacOS app compile target — architecture coverage and artifact identity\n');

console.log('1. the Python path builds on an Intel runner, because it cannot cross-build');
const pyRunners = macAppRunners(pythonOwnScript);
check('Python (own build script) declares two runners', pyRunners.length, 2);
check('…one of them is the Intel runner',
  pyRunners.some((r) => r.runner === 'macos-15-intel'), true);
check('…and the other is the Apple-silicon runner',
  pyRunners.some((r) => r.runner === 'macos-latest'), true);
check('the plain PyInstaller path (no build script) behaves identically',
  macAppRunners(pythonPlain), pyRunners);
check('every leg is labelled, and the labels are distinct',
  new Set(pyRunners.map((r) => r.arch)).size, pyRunners.length);

console.log('\n2. the paths that already cover both Macs stay one-runner jobs');
check('Swift is one universal build', macAppRunners(swift), [{ runner: 'macos-latest', arch: 'universal' }]);
check('Node is one universal build', macAppRunners(node), [{ runner: 'macos-latest', arch: 'universal' }]);

console.log('\n3. a runner list renders a build matrix, and a list of one still does');
const pyWorkflow = renderWorkflow(pyRunners, macApp.buildSteps(pythonOwnScript), macApp.artifact);
check('the Python workflow is a matrix',
  /\n\s+strategy:\n/.test(pyWorkflow) && /\n\s+matrix:\n/.test(pyWorkflow), true);
check('…fail-fast is off, so the Intel leg still reports when the other fails',
  /fail-fast: false/.test(pyWorkflow), true);
check('…it runs on the matrix runner', /runs-on: \$\{\{ matrix\.runner \}\}/.test(pyWorkflow), true);
for (const r of pyRunners) {
  check(`…the matrix includes ${r.runner} / ${r.arch}`,
    new RegExp(`- runner: ${r.runner}\\n\\s+arch: ${r.arch}`).test(pyWorkflow), true);
}
const swiftWorkflow = renderWorkflow(macAppRunners(swift), macApp.buildSteps(swift), macApp.artifact);
check('a single runner is still a matrix, so ${{ matrix.arch }} is never empty',
  /runs-on: \$\{\{ matrix\.runner \}\}/.test(swiftWorkflow), true);
// The negative half: a bare string runner must NOT become a matrix, or every other target changes shape.
const plainWorkflow = renderWorkflow('ubuntu-latest', macApp.buildSteps(swift), macApp.artifact);
check('a bare runner string still renders exactly as before',
  /runs-on: ubuntu-latest\n/.test(plainWorkflow) && !/strategy:/.test(plainWorkflow), true);

console.log('\n4. the disk image, the release glob and the verify step all name the same file');
// This is the "artifact/verify mismatch" the compile-target audit checked by eye. It matters more now that
// the name is templated: three places have to agree, per matrix leg, or the build goes green having
// published nothing (or fails on a file it did publish).
const ARCH_NAME = 'app-macos-${{ matrix.arch }}.dmg';
check('artifact.glob names the architecture', macApp.artifact.glob, ARCH_NAME);
check('artifact.isGlob is false — it is one file per leg, not a wildcard',
  macApp.artifact.isGlob, false);
check('the verify step tests for that same file',
  macApp.artifact.verifyCommand.startsWith(`test -f ${ARCH_NAME} `), true);
check('artifactName is gone, so no downstream rename can drop the architecture',
  'artifactName' in macApp.artifact, false);
for (const [label, files] of [['python (own build script)', pythonOwnScript], ['python (plain)', pythonPlain], ['swift', swift], ['node', node]]) {
  const steps = macApp.buildSteps(files);
  const run = steps.map((s) => s.run || '').join('\n');
  check(`${label}: hdiutil writes exactly ${ARCH_NAME}`,
    new RegExp(`hdiutil create[^\\n]*-format UDZO ${ARCH_NAME.replace(/[$]/g, '\\$').replace(/\{\{/g, '\\{\\{').replace(/\}\}/g, '\\}\\}')}`).test(run), true);
}
check('the release step uploads the file the build wrote',
  pyWorkflow.split('\n').some((l) => l.trim() === ARCH_NAME), true);

console.log('\n5. a project\'s own disk image is never nested inside ours');
for (const [label, files] of [['python (own build script)', pythonOwnScript], ['python (plain)', pythonPlain]]) {
  const run = macApp.buildSteps(files).map((s) => s.run || '').join('\n');
  check(`${label}: staging excludes *.dmg`, run.includes("--exclude '*.dmg'"), true);
  check(`${label}: staging no longer copies dist/ wholesale`,
    run.includes('cp -R dist/. dmg_staging/'), false);
  check(`${label}: the .app bundles are preferred when there are any`,
    run.includes('cp -R dist/*.app'), true);
}

console.log('\n6. the caller passes the runner list through');
const compileProject = read('../server/src/functions/compileProject.js');
check('compileProject asks the adapter for its runners',
  /adapter\.runners\(files\)/.test(compileProject), true);
check('…and hands them to the renderer instead of always using adapter.runner',
  /renderWorkflow\(runners \|\| adapter\.runner, steps, adapter\.artifact/.test(compileProject), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log('macOS architecture coverage: OK');
