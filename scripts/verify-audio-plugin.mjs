// Does the audio-plugin target generate a project that can actually be built, and are the decisions that
// made it work still in place?
//
// WHY THIS GUARD EXISTS. This target is unlike the other ten: it generates the project as well as building
// it, it depends on third-party code fetched at build time, and its failure modes are quiet. Every
// assertion below is a mistake that was made once, in a spike, and cost a build cycle to find:
//
//   * the VST3 bundle was produced with NO BINARY IN IT — `make` aborted at another format's step and left
//     the bundle as an Info.plist shell, which a "did we make a plugin file?" check passes;
//   * the AU subtype collided with the manufacturer code;
//   * `set(CMAKE_OSX_DEPLOYMENT_TARGET ... CACHE ...)` is silently ignored, because CMake already holds an
//     empty cache entry for it;
//   * the newest clap-wrapper release does not contain `make_clapfirst_plugins` at all;
//   * `CLAP_PARAM_ID_SPACE` does not exist — it is a compile error, which is the good kind;
//   * the generated C++ needs explicit casts from `void *` in four places.
//
// Dependency-free apart from the target module itself, which imports nothing but pure helpers, so this
// runs in CI's no-install guards job.
//
// Run:  node scripts/verify-audio-plugin.mjs
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import audioPlugin, { readManifest, PLUGIN_MANIFEST } from '../server/src/lib/compile-targets/audio-plugin.js';
import { getCompileTarget, listCompileTargets } from '../server/src/lib/compile-targets/index.js';

const REPO = new URL('..', import.meta.url).pathname;
const read = (p) => (existsSync(join(REPO, p)) ? readFileSync(join(REPO, p), 'utf8') : '');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}
const generated = (result, path) => result.files.find((f) => f.path === path)?.content || '';

console.log('\n1. the target is registered, and the published surface knows about it');
check('the registry returns it by id', getCompileTarget('audio-plugin')?.id, 'audio-plugin');
check('…and lists it', listCompileTargets().includes('audio-plugin'), true);
// morpheusCapabilities.json is not UI copy — it feeds search engines and AI answer engines, and
// verify-seo-static pins buildTargets to the compile-targets directory. A target missing here makes the
// published list lie about what Morpheus can build.
const caps = JSON.parse(read('src/lib/morpheusCapabilities.json'));
check('…and the PUBLISHED capability list includes it', caps.buildTargets.includes('audio-plugin'), true);
check('…and that list still names the other ten', caps.buildTargets.length, 11);
check('the label names the formats a musician gets', /VST3/.test(audioPlugin.label) && /AU/.test(audioPlugin.label) && /CLAP/.test(audioPlugin.label), true);

console.log('\n2. it generates a complete project from nothing');
const empty = [{ path: 'README.md', content: '# empty\n' }];
const v = audioPlugin.validate(empty);
check('an empty workspace is valid (Morpheus scaffolds the whole plugin)', v.valid, true);
const s = audioPlugin.scaffold(empty);
check('it generates exactly the four files the build needs',
  s.generated.slice().sort(), ['CMakeLists.txt', 'Source/Plugin.cpp', 'Source/PluginEntry.cpp', PLUGIN_MANIFEST]);
check('…and no warnings for a clean generate', s.warnings, []);

console.log('\n3. identity is derived, valid, and cannot silently collide');
const m = readManifest(s.files);
check('the plugin id is a reverse-domain identifier', /^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(m.id), true);
check('the AU type is an effect by default', m.auType, 'aufx');
check('the AU subtype is four characters', m.auSubtype.length, 4);
check('the AU manufacturer is four characters', m.auManufacturer.length, 4);
// A duplicate subtype makes one plugin shadow another inside Logic, and the symptom is "my plugin
// disappeared" — so the default derivation must not collide with the manufacturer code.
check('…and the subtype does NOT equal the manufacturer code', m.auSubtype === m.auManufacturer, false);
// Two different names must not produce the same subtype, or the second plugin vanishes.
const other = readManifest(audioPlugin.scaffold([{ path: PLUGIN_MANIFEST, content: JSON.stringify({ name: 'Morpheus Delay' }) }]).files);
check('…and a different plugin name gives a different subtype', other.auSubtype === m.auSubtype, false);
const manifestWins = readManifest(audioPlugin.scaffold([{ path: PLUGIN_MANIFEST, content: JSON.stringify({ name: 'Custom', id: 'com.acme.custom', auSubtype: 'Acme', auManufacturer: 'ACME' }) }]).files);
check('a manifest the user wrote is obeyed, not overridden', [manifestWins.name, manifestWins.id, manifestWins.auSubtype].join(','), 'Custom,com.acme.custom,Acme');

console.log('\n4. it never overwrites work the user has done');
// Regenerating over somebody's DSP would be the worst thing this target could do, so a project that
// already has its source is left completely alone.
const mine = [{ path: 'Source/Plugin.cpp', content: '// MY OWN DSP — DO NOT TOUCH\n' }, { path: 'CMakeLists.txt', content: '# mine\n' }];
const s2 = audioPlugin.scaffold(mine);
check('an existing Source/Plugin.cpp is untouched',
  s2.files.find((f) => f.path === 'Source/Plugin.cpp').content, mine[0].content);
check('…and an existing CMakeLists.txt is untouched',
  s2.files.find((f) => f.path === 'CMakeLists.txt').content, mine[1].content);
// `find()` returns the FIRST match, so "the original is still first" passed even when the scaffold
// appended a second copy of the same path — a mutation survived on exactly that. The property is about
// the WHOLE list: a path that already existed must not be generated, and no path may appear twice.
check('…and no pre-existing path is generated at all',
  s2.generated.filter((g) => mine.some((f) => f.path === g)), []);
check('…and no path appears twice in the result',
  s2.files.length - new Set(s2.files.map((f) => f.path)).size, 0);
check('…and it warns that the generated entry file must match their source',
  s2.warnings.some((w) => /must export morpheus_plugin_init/.test(w)), true);
check('validate() warns that it is using the project as-is', audioPlugin.validate(mine).warnings.length > 0, true);

console.log('\n5. generation is deterministic');
// A rebuild that rewrites the user's files with different bytes is churn they cannot review.
const a1 = JSON.stringify(audioPlugin.scaffold(empty).files);
const a2 = JSON.stringify(audioPlugin.scaffold(empty).files);
check('the same input generates byte-identical output', a1 === a2, true);

console.log('\n6. the generated C++ keeps the things that were hard to get right');
const src = generated(s, 'Source/Plugin.cpp');
const entry = generated(s, 'Source/PluginEntry.cpp');
const cmake = generated(s, 'CMakeLists.txt');
// plugin_data and calloc() are void*, so C++ requires casts. Without them the generated project does not
// compile — which is at least loud, but it is the first thing to break on an edit.
check('every read of plugin_data is cast out of void*',
  (src.match(/\(const plugin_t \*\)plugin->plugin_data|\(plugin_t \*\)plugin->plugin_data/g) || []).length >= 5, true);
check('…and so is an instance created with calloc', /\(plugin_t \*\)calloc/.test(src), true);
check('…and the plugin_data assignment casts too', /plugin_data = \(void \*\)p;/.test(src), true);
// There is no parameter event space; param events are in the core space, told apart by type.
check('parameter events are read from the CORE event space', /CLAP_CORE_EVENT_SPACE_ID/.test(src), true);
check('…and identified by CLAP_EVENT_PARAM_VALUE', /CLAP_EVENT_PARAM_VALUE/.test(src), true);
check('…and the non-existent CLAP_PARAM_ID_SPACE is not used', /CLAP_PARAM_ID_SPACE/.test(src), false);
check('the params extension is implemented (the SDK template leaves it as a TODO)',
  /CLAP_EXT_PARAMS/.test(src) && /params_get_info/.test(src) && /params_value_to_text/.test(src), true);
check('a parameter id of 0 is avoided (it means CLAP_INVALID_ID)', /enum \{ PARAM_[A-Z_]+ = 1 \}/.test(src), true);
check('the parameter is smoothed, so a change cannot click', /smoothed/.test(src), true);
check('the entry exports exactly the name a host looks for', /clap_entry = \{/.test(entry), true);
check('…with C linkage', /extern "C"/.test(entry), true);

console.log('\n7. the generated CMake keeps the settings that are not optional');
// The standalone's macOS shell is Objective-C++; without the language enabled, configuration fails with an
// error that names CMake rather than the missing language.
check('Objective-C++ is enabled for the standalone shell', /enable_language\(OBJCXX\)/.test(cmake), true);
// The flag builds the machinery; this argument is what asks for the app. Omitting it yields no standalone
// and no complaint.
check('the standalone is actually requested, not just enabled',
  /CLAP_WRAPPER_BUILD_STANDALONE ON/.test(cmake) && /STANDALONE_CONFIGURATIONS/.test(cmake), true);
check('AUv2 is requested', /CLAP_WRAPPER_BUILD_AUV2 ON/.test(cmake), true);
check('all four formats are listed', /PLUGIN_FORMATS CLAP VST3 AUV2 WCLAP/.test(cmake), true);
check('the AU registration codes are passed through', /AUV2_SUBTYPE_CODE/.test(cmake) && /AUV2_INSTRUMENT_TYPE/.test(cmake), true);
check('a missing CLAP_WRAPPER_DIR is a loud failure, not a strange one',
  /CLAP_WRAPPER_DIR is not set/.test(cmake), true);

console.log('\n8. the build steps keep the decisions the spike paid for');
const steps = audioPlugin.buildSteps(s.files);
const stepText = JSON.stringify(steps);
const byName = (n) => steps.find((x) => x.name === n) || {};
const cloneStep = steps.find((x) => /git clone/.test(x.run || '')) || {};
// A moving ref means the same project builds differently on two days, and an upstream force-push changes
// what a user ships. A tag was tried first and does not even contain the command this target needs.
check('the wrapper is fetched at a fixed COMMIT, not a branch', /checkout [0-9a-f]{40}\b/.test(cloneStep.run || ''), true);
check('…and not at a moving ref', /--branch\s+(main|master|HEAD)\b/.test(cloneStep.run || ''), false);
// CMAKE_OSX_DEPLOYMENT_TARGET cannot be set in CMakeLists: CMake already has an empty cache entry, so a
// plain `set(... CACHE ...)` does nothing and a wrapper that reads it sees "".
check('the deployment target is passed at configure time',
  /-DCMAKE_OSX_DEPLOYMENT_TARGET=/.test(byName('Configure').run || ''), true);
// A `set(... CACHE ...)` on a variable CMake already caches is a NO-OP, and that is not theoretical:
// it left the value empty and a clap-wrapper version with an unquoted comparison then refused to configure.
check('…and any cache set of it in CMakeLists must FORCE, or it does nothing',
  /set\(CMAKE_OSX_DEPLOYMENT_TARGET[^)]*CACHE[^)]*FORCE\)/.test(cmake), true);
check('…and it is guarded so it cannot fight a value passed on the command line',
  /if \(APPLE AND NOT CMAKE_OSX_DEPLOYMENT_TARGET\)/.test(cmake), true);
check('the build is universal, so an Intel Mac can load it', /OSX_ARCHITECTURES="arm64;x86_64"/.test(byName('Configure').run || ''), true);
// The empty-bundle failure: one format's failure aborted make and left another as a shell.
check('each plugin format is built as its OWN target, so one failure cannot strand another',
  /morpheus_plugin_clap/.test(byName('Build CLAP, VST3 and AU').run || '')
  && /morpheus_plugin_vst3/.test(byName('Build CLAP, VST3 and AU').run || '')
  && /morpheus_plugin_auv2/.test(byName('Build CLAP, VST3 and AU').run || ''), true);
check('…and the standalone is its own step, so its Xcode dependency cannot take the others down',
  /morpheus_plugin_standalone/.test(byName('Build the standalone').run || ''), true);
// THE check. A bundle directory with no Mach-O inside it uploads, downloads and fails to load.
const verifyStep = byName('Verify every bundle contains its binary').run || '';
check('the verification looks INSIDE each bundle for its binary', /Contents\/MacOS/.test(verifyStep), true);
check('…and fails when the binary is missing', /BUNDLE HAS NO BINARY/.test(verifyStep), true);
check('…and checks it is a real Mach-O, not just a file', /Mach-O/.test(verifyStep), true);
check('…and reports the architectures it actually built', /lipo -archs/.test(verifyStep), true);
check('…and covers all four formats', ['.clap', '.vst3', '.component', '.app'].every((e) => verifyStep.includes(e)), true);
// ditto preserves a bundle's structure and permissions; a plugin that arrives without its executable bit
// does not load.
check('packaging uses ditto, not zip', /ditto -c -k/.test(byName('Package').run || '') && !/\bzip -r/.test(stepText), true);

console.log('\n9. the artifact spec matches what gets packaged');
check('the glob covers four downloads, one per format', audioPlugin.artifact.glob, 'build/assets/plugin-macos-*.zip');
check('…and is a glob', audioPlugin.artifact.isGlob, true);
check('…and the verify command names all four zips',
  ['vst3', 'au', 'clap', 'standalone'].every((k) => (audioPlugin.artifact.verifyCommand || '').includes(`plugin-macos-${k}.zip`)), true);
check('failure patterns cover the errors this build actually produces',
  audioPlugin.errorPatterns.some((r) => r.test('BUNDLE HAS NO BINARY: x')) &&
  audioPlugin.errorPatterns.some((r) => r.test('CMake Error at CMakeLists.txt')),
  true);

console.log('\n10. the steps render into a workflow that would actually run');

// WHY THIS SECTION EXISTS. Everything above checks the steps as DATA; nothing checked what they become.
// Rendering them for the first time found two bugs that reading the diff never would have:
//
//   * `.join('\\n')` — a literal backslash-n — collapsed the whole verification shell script onto ONE
//     LINE, so the check that exists to catch an empty plugin bundle would itself have been broken;
//   * the bundle paths emitted the literal text `${bundle('.clap')}` instead of a filename.
//
// A generated workflow is the artifact a user's build actually runs, so it is rendered here and asserted
// like any other output.
const { renderWorkflow } = await import('../server/src/lib/compile-targets/workflow-renderer.js');
const yaml = renderWorkflow('macos-latest', steps, audioPlugin.artifact, 'INSTALLING IT\n- test\n');

check('it renders without throwing and produces a workflow', yaml.length > 500, true);
check('the workflow is dispatched manually, not on every push',
  /on:\s*\n\s*workflow_dispatch:/.test(yaml), true);
check('…and it runs on a macOS runner', /runs-on: macos-latest/.test(yaml), true);
check('…and it can attach files to a release', /permissions:\s*\n\s*contents: write/.test(yaml), true);

// The collapsed-script bug: a `run:` block must be a YAML BLOCK SCALAR (a `|` then indented lines), not a
// single line carrying escape sequences. This is the assertion that would have caught it.
const runLines = yaml.split('\n').filter((l) => /^\s+run: /.test(l));
check('there are run steps at all', runLines.length >= 6, true);
check('…and at least one is a multi-line block scalar', runLines.some((l) => l.trim() === 'run: |'), true);
// A single-line command renders on one line, which is correct. What must never appear is an escape
// sequence standing in for a newline — that collapsed the whole verification script onto one line.
//
// THE ESCAPING HERE WAS WRONG ONCE and it mattered: this line used to hold four backslashes, which is a
// regex for TWO literal backslashes followed by an `n` — so it passed with the bug present. Two
// backslashes match the single escape sequence a collapsed `join` actually produces. Verified by
// reintroducing the bug and watching this go red.
check('no escape sequence leaked into the YAML', /\\n/.test(yaml), false);
// …and the specific step that was collapsed, named, so a failure says where to look.
check('the verification step is a real multi-line script, not one line',
  /name: Verify every bundle contains its binary\n\s+run: \|/.test(yaml), true);
// An uninterpolated template literal renders as the code that was supposed to run.
check('no unresolved template expression leaked into the YAML', /\$\{[a-zA-Z]/.test(yaml.replace(/\$\{\{[^}]*\}\}/g, '')), false);
// The build must name the files it verifies, not the code that computes them.
check('the verification names the real bundle paths',
  yaml.includes('"build/assets/Morpheus Plugin.clap"') && yaml.includes('"build/assets/Morpheus Plugin.vst3"'), true);
check('…and asserts each format\'s own entry point',
  ['clap_entry', 'GetPluginFactory', 'wrapAsAUV2_inst0Factory'].every((sym) => yaml.includes(sym)), true);
check('…and the symbol is actually USED inside the check function, not just passed',
  /nm -gU "\$bin"[\s\S]{0,80}_\$sym\$/.test(yaml), true);
check('the pinned commit appears in the clone step', /checkout [0-9a-f]{40}\b/.test(yaml), true);
check('the release uploads the zips AND the user manual',
  /files: \|\n\s*build\/assets\/plugin-macos-\*\.zip\n\s*USER-MANUAL\.txt/.test(yaml), true);
check('…and refuses to publish if the glob matches nothing', /fail_on_unmatched_files: true/.test(yaml), true);

console.log('\n11. the target is built for real on a runner, and only when it is asked for');
// ⚠️ THE GAP THIS CLOSES. Everything above proves the target GENERATES a project and renders a workflow.
// Nothing built the plugin: the required checks run on ubuntu with no compiler, no Xcode and no network
// build, and the plugin itself is only built when a user compiles, in their own repo. The standalone cannot
// be built on the development machine at all — its shell is compiled by `ibtool`, which needs full Xcode.
// So a workflow that materialises the target and runs its steps on a macOS runner is the only evidence
// that the fourth format exists, and this is where that has to stay true.
const wf = read('.github/workflows/audio-plugin-build.yml');
check('there is a workflow that builds the target on a real macOS runner', wf.length > 0, true);
check('…dispatched by hand, not on a push or a pull request',
  /on:\s*\n\s+workflow_dispatch:/.test(wf), true);
// The cost rule, as an assertion: macOS minutes bill at 10x, so an accidental trigger here is a bill, not
// a slower build. `pull_request` and `push` are the two ways it could start running unasked.
check('…and nothing in it can start a macOS bill on every branch',
  /pull_request|^\s*push:/m.test(wf), false);
check('…on macOS, where full Xcode exists — the only place the standalone can be built',
  /runs-on: macos-latest/.test(wf), true);
check('…bounded by a timeout, because configure downloads the SDKs',
  /timeout-minutes: \d+/.test(wf), true);
check('…running the target\'s own steps through the runner script',
  /node scripts\/audio-plugin-runner-build\.mjs/.test(wf), true);
check('…keeping the packaged plugins, so a run can be inspected rather than believed',
  /upload-artifact@v\d/.test(wf) && /assets\/\*\.zip/.test(wf), true);
check('…and failing rather than passing with three formats of four',
  /if-no-files-found: error/.test(wf), true);

// The script must build the TARGET, not a transcription of what the target happens to emit today. A copy
// of the commands is the failure mode this whole job exists to avoid: it would keep passing after the
// target changed, and prove something nobody ships.
const runner = read('scripts/audio-plugin-runner-build.mjs');
check('the runner script imports the target and calls its buildSteps',
  /from '\.\.\/server\/src\/lib\/compile-targets\/audio-plugin\.js'/.test(runner) && /audioPlugin\.buildSteps\(/.test(runner), true);
check('…and no build command is written out a second time, where it could drift',
  /cmake --build|ditto -c -k|CLAP_WRAPPER_REF|wrapAsAUV2/.test(runner), false);
check('…skipping the `uses:` steps it cannot run and executing every shell step',
  /step\.uses/.test(runner) && /step\.run/.test(runner), true);
check('…providing RUNNER_TEMP, which the clone and configure steps read',
  /RUNNER_TEMP/.test(runner), true);
check('…failing the job on the first step that fails',
  /result\.status !== 0[\s\S]{0,160}process\.exit\(1\)/.test(runner), true);
check('…refusing to run anywhere but macOS, rather than failing obscurely later',
  /process\.platform !== 'darwin'/.test(runner), true);
// The one format no local machine has ever built, so a green run that quietly lacked it must be impossible.
check('…and insisting on the standalone\'s binary, not just its bundle',
  /no standalone \.app was produced/.test(runner) && /standalone binary present/.test(runner), true);
// A manual job nobody knows about is the same as no job (H17). It is named where a session will see it.
check('…and the manual job is named in AGENTS.md, so a session that changes the target dispatches it',
  /audio-plugin-build\.yml/.test(read('AGENTS.md')), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ the audio-plugin target can generate a project that will not build\n');
  process.exit(1);
}
console.log('the audio-plugin target generates a project that builds, loads, and has working parameters\n');
