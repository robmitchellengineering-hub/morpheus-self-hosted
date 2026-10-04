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
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import audioPlugin, { readManifest, PLUGIN_MANIFEST } from '../server/src/lib/compile-targets/audio-plugin-macos.js';
import audioPluginWindows from '../server/src/lib/compile-targets/audio-plugin-windows.js';
import audioPluginLinux from '../server/src/lib/compile-targets/audio-plugin-linux-arm.js';
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
check('the registry returns it by id', getCompileTarget('audio-plugin-macos')?.id, 'audio-plugin-macos');
check('…and lists it', listCompileTargets().includes('audio-plugin-macos'), true);
// morpheusCapabilities.json is not UI copy — it feeds search engines and AI answer engines, and
// verify-seo-static pins buildTargets to the compile-targets directory. A target missing here makes the
// published list lie about what Morpheus can build.
const caps = JSON.parse(read('src/lib/morpheusCapabilities.json'));
check('…and the PUBLISHED capability list includes it', caps.buildTargets.includes('audio-plugin-macos'), true);
// One entry per target, counted against the registry rather than a number written here: the published list
// is what search engines and AI answer engines read, and this target count has already changed once.
check('…and every registered target is published', caps.buildTargets.length, listCompileTargets().length);
check('…including all three audio plugin routes',
  caps.buildTargets.includes('audio-plugin-macos') && caps.buildTargets.includes('audio-plugin-windows')
  && caps.buildTargets.includes('audio-plugin-linux-arm'), true);
check('the label names the formats a musician gets', /VST3/.test(audioPlugin.label) && /AU/.test(audioPlugin.label) && /CLAP/.test(audioPlugin.label), true);
// ⚠️ THE PLATFORM WAS THE MISSING WORD, and it is a product problem rather than a wording one: a VST3
// exists on more than one machine, so a label naming only the formats reads as "builds for whatever you are
// on". Someone on Windows picks it, waits for a compile, and receives files that cannot load — and the AU
// in it cannot exist on their machine at all. So the id, the label and the manual all carry the OS.
check('the label names the PLATFORM, not only the formats', /macOS/i.test(audioPlugin.label), true);
check('…and the id does too, so the published target list is unambiguous', audioPlugin.id, 'audio-plugin-macos');

// The manual is where a user finds out what they cannot do, so the first thing it says is the platform.
const manualSrc = read('server/src/lib/appUserManual.js');
const macManual = /'audio-plugin-macos': \{[\s\S]*?install: \[([\s\S]*?)\],/.exec(manualSrc)?.[1] || '';
check('the manual has a section under the route\'s id', macManual.length > 0, true);
check('…which opens by saying it is macOS only', /MACOS ONLY/i.test(macManual), true);
check('…and names the reason a user cannot argue with', /Audio Unit/i.test(macManual), true);
// The picker is how a user chooses a route at all; a target missing from it cannot be chosen, whatever the
// registry says. See verify-onramp.mjs, which compares the two lists in full.
check('…and the route is offered in the picker', read('src/lib/compileTargets.js').includes(`value: '${audioPlugin.id}'`), true);

console.log('\n2. it generates a complete project from nothing');
const empty = [{ path: 'README.md', content: '# empty\n' }];
const v = audioPlugin.validate(empty);
check('an empty workspace is valid (Morpheus scaffolds the whole plugin)', v.valid, true);
const s = audioPlugin.scaffold(empty);
// Six rather than four since models landed: `ModelData.{h,cpp}` are generated for EVERY project, including
// one with no model, because the plugin includes the header unconditionally and branches on
// MORPHEUS_HAS_MODEL inside it. That is what keeps Source/Plugin.cpp the same text either way.
check('it generates exactly the six files the build needs',
  s.generated.slice().sort(), ['CMakeLists.txt', 'Source/ModelData.cpp', 'Source/ModelData.h', 'Source/Plugin.cpp', 'Source/PluginEntry.cpp', PLUGIN_MANIFEST]);
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
// ⚠️ THESE TWO ARE THE FIRST WINDOWS BUILD, TURNED INTO ASSERTIONS — and neither is visible without a second
// compiler, which is exactly why they survived a day of green macOS runs. Clang accepts a C99 COMPOUND
// LITERAL inside C++ as an extension, and accepts designated initializers (a C++20 feature) while the
// project declared C++17. MSVC refuses both: `error C4576` and `error C7555`. The plugin source is the one
// place in this repo where the compiler is not clang, so the portability of what we GENERATE is asserted
// here rather than discovered on a runner.
const compoundLiteral = (s2) => /\([A-Za-z_][A-Za-z0-9_ ]*\[\]\)\s*\{|= \([A-Za-z_][A-Za-z0-9_]*\)\s*\{/.test(s2);
check('the feature list is a named array, not a C99 compound literal',
  /static const char \*const kFeatures\[\] = \{/.test(src), true);
check('…and the descriptor points at it rather than building one inline',
  /\.features = kFeatures,/.test(src), true);
check('no compound literal survives anywhere in the generated C++ (MSVC: C4576)',
  compoundLiteral(src) || compoundLiteral(entry), false);
check('the project declares C++20, because the source uses designated initializers (MSVC: C7555)',
  /set\(CMAKE_CXX_STANDARD 20\)/.test(cmake), true);
// …and the standard must be set BEFORE the wrappers are added, or clap-wrapper defaults it to 17 and the
// line above is decoration. This is the kind of ordering nothing else would notice.
check('…and it is declared before clap-wrapper is added, or the wrapper overrides it',
  cmake.indexOf('set(CMAKE_CXX_STANDARD 20)') < cmake.indexOf('add_subdirectory('), true);
// ⚠️ THE SECOND WINDOWS BUILD, TURNED INTO AN ASSERTION. clap-wrapper sets the static MSVC runtime for its
// OWN targets, and that setting does not reach the targets created in THIS file — so the VST3 SDK's static
// libraries met our DLL-runtime wrapper object and the link died with LNK2038 (MT_StaticRelease vs
// MD_DynamicRelease). Ordering is the whole claim again: it must be set before anything is created.
check('the MSVC runtime is pinned to the static one, so it cannot mix with the SDK\'s',
  /if \(MSVC\)\s*\n\s*set\(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded\$<\$<CONFIG:Debug>:Debug>"/.test(cmake), true);
check('…and pinned BEFORE clap-wrapper is added, for the same ordering reason',
  cmake.indexOf('set(CMAKE_MSVC_RUNTIME_LIBRARY') < cmake.indexOf('add_subdirectory('), true);
// ⚠️ THE FIRST LINUX BUILD, TURNED INTO AN ASSERTION, and it is the same shape as the Windows one: a
// library built for one configuration meeting an object built for another. The VST3 SDK is a STATIC library
// and CMake does not build static libraries position-independent by default; a VST3 on Linux is a SHARED
// OBJECT, so the link died with
//   R_AARCH64_ADR_PREL_PG_HI21 against '_ZSt19piecewise_construct' ... recompile with -fPIC
// It is not an ARM problem — x86-64 fails the same way with R_X86_64_32S — and the two platforms this
// project built on before do not have it because MSVC and clang default to PIC. Setting it per-target
// would not help: the offending relocations are inside the SDK's own objects, which is why it belongs
// before add_subdirectory and why the ordering is asserted rather than assumed.
check('…the whole Linux subtree is built position-independent, without which the VST3 link cannot succeed',
  /if \(UNIX AND NOT APPLE\)[\s\S]*?set\(CMAKE_POSITION_INDEPENDENT_CODE ON CACHE BOOL/.test(cmake), true);
check('…and set BEFORE clap-wrapper is added, so it reaches the SDK\'s static libraries too',
  cmake.indexOf('set(CMAKE_POSITION_INDEPENDENT_CODE') > 0
  && cmake.indexOf('set(CMAKE_POSITION_INDEPENDENT_CODE') < cmake.indexOf('add_subdirectory('), true);
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
check('AUv2 is requested where an AU exists', /CLAP_WRAPPER_BUILD_AUV2 ON/.test(cmake), true);
// ⚠️ THE AU IS APPLE-ONLY, AND THE FLAG MATTERS AS MUCH AS THE LIST. Both routes generate this SAME
// project — that is the point of lib/audioPluginProject.js — so the generated CMakeLists has to configure
// correctly on whichever platform builds it. Two separate mistakes live here, and the second is the quiet
// one: leaving AUV2 in the format list is merely skipped by clap-wrapper (`if (APPLE AND …)`), but leaving
// `CLAP_WRAPPER_BUILD_AUV2` ON makes a WINDOWS configure fetch Apple's AudioUnitSDK.
check('the base format list is the three that exist everywhere',
  /set\(PLUGIN_FORMATS CLAP VST3 WCLAP\)/.test(cmake), true);
check('…with the AU appended only on Apple',
  /if \(APPLE\)\s*\n\s*list\(APPEND PLUGIN_FORMATS AUV2\)/.test(cmake), true);
check('…and the AU wrapper flag turned OFF off-Apple, so no AudioUnitSDK is fetched',
  /else\(\)\s*\n\s*set\(CLAP_WRAPPER_BUILD_AUV2 OFF/.test(cmake), true);
check('…and the AU registration arguments are passed only where an AU is built',
  /set\(AU_ARGS ""\)/.test(cmake) && /\$\{AU_ARGS\}/.test(cmake), true);
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
const wf = read('.github/workflows/audio-plugin-macos-build.yml');
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
  /node scripts\/audio-plugin-macos-runner-build\.mjs/.test(wf), true);
check('…keeping the packaged plugins, so a run can be inspected rather than believed',
  /upload-artifact@v\d/.test(wf) && /assets\/\*\.zip/.test(wf), true);
check('…and failing rather than passing with three formats of four',
  /^\s+if-no-files-found: error$/m.test(wf), true);

// The script must build the TARGET, not a transcription of what the target happens to emit today. A copy
// of the commands is the failure mode this whole job exists to avoid: it would keep passing after the
// target changed, and prove something nobody ships.
const runner = read('scripts/audio-plugin-macos-runner-build.mjs');
check('the runner script imports the target and calls its buildSteps',
  /from '\.\.\/server\/src\/lib\/compile-targets\/audio-plugin-macos\.js'/.test(runner) && /audioPlugin\.buildSteps\(/.test(runner), true);
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
// Asserted as a REFUSAL THAT EXITS, not as the wording of its message — the message alone is a check
// satisfied by a string, which is the failure this file has already been caught by once (see above): the
// workflow's own comment quotes `if-no-files-found: error`, so a plain search for the setting matched its
// own explanation and stayed green with the setting deleted.
check('…and refusing when no standalone was produced, rather than summarising three formats of four',
  /if \(!standalone\) \{[\s\S]{0,240}process\.exit\(1\)/.test(runner), true);
check('…and refusing a standalone bundle that exists with no binary in it',
  /if \(!existsSync\(standaloneBin\)\) \{[\s\S]{0,240}process\.exit\(1\)/.test(runner), true);
// A manual job nobody knows about is the same as no job (H17). It is named where a session will see it.
check('…and the manual job is named in AGENTS.md, so a session that changes the target dispatches it',
  /audio-plugin-macos-build\.yml/.test(read('AGENTS.md')), true);

console.log('\n12. the WINDOWS route is a Windows route, and builds the same plugin');
// The second half of Rob's requirement: "…same for the windows one your about to build." Everything section
// 11 asserts about the macOS route's reachability and labelling applies here, plus the things that are
// genuinely different about building a plugin on Windows — and one that must NOT be different, which is the
// plugin itself.
check('the registry returns it by id', getCompileTarget('audio-plugin-windows')?.id, 'audio-plugin-windows');
check('…and lists it', listCompileTargets().includes('audio-plugin-windows'), true);
check('the label names the platform, not only the formats', /Windows/i.test(audioPluginWindows.label), true);
check('…and does NOT promise an Audio Unit, which cannot exist off Apple',
  /AU\b|Audio Unit/i.test(audioPluginWindows.label), false);
check('…and the route is offered in the picker',
  read('src/lib/compileTargets.js').includes(`value: '${audioPluginWindows.id}'`), true);
const winManual = /'audio-plugin-windows': \{[\s\S]*?install: \[([\s\S]*?)\],/.exec(manualSrc)?.[1] || '';
check('its manual opens by saying it is Windows only', /WINDOWS ONLY/i.test(winManual), true);
check('…and says why there is no Audio Unit in it', /Audio Unit/i.test(winManual), true);
check('…and names the install folder a musician cannot guess', /Common Files/i.test(winManual), true);

// ⭐ THE ANTI-DRIFT CLAIM, and the reason the generator was extracted rather than copied: the two routes
// must generate the SAME project. If they ever diverge, one of them silently builds a different plugin than
// the one its guard tested — with both green.
check('both routes generate byte-identical projects from one generator',
  JSON.stringify(audioPluginWindows.scaffold(empty).files), JSON.stringify(audioPlugin.scaffold(empty).files));

const winSteps = audioPluginWindows.buildSteps(audioPluginWindows.scaffold(empty).files);
const winRun = winSteps.filter((s) => s.run).map((s) => s.run).join('\n');
check('the build runs in PowerShell, like the runner does',
  /\$ErrorActionPreference/.test(winRun) && /if \(\$LASTEXITCODE -ne 0\)/.test(winRun), true);
// A POSIX command in a Windows step does not fail loudly — it fails as "not recognized", after the step has
// already done half its work, or on GitHub it fails as a syntax error naming nothing useful.
check('…and carries no POSIX-only command from the macOS route',
  /sysctl|ditto -c -k|\blipo\b|set -e\b|nm -gU/.test(winRun), false);
check('each format is built as its own target, so one failure cannot strand the others',
  /--target \$t/.test(winRun) && /morpheus_plugin_clap/.test(winRun) && /morpheus_plugin_standalone/.test(winRun), true);
// The Windows layout is NOT the macOS one, which is the mistake this step exists to prevent: a check written
// for `Contents/MacOS/<name>` finds nothing here and reports every format missing.
check('the verification looks where clap-wrapper actually puts these on Windows',
  /build\/assets\/CLAP/.test(winRun) && /build\/assets\/VST3/.test(winRun) && /Standalone-morpheus_plugin_standalone/.test(winRun), true);
// ⚠️ RUN FOUR, TURNED INTO AN ASSERTION. Knowing the DIRECTORY was not enough: the Visual Studio generator
// is MULTI-CONFIG, so CMake appends the configuration to every output directory and the artifact sits one
// level deeper than reading the CMake suggests — `…/VST3/Release/<name>.vst3`. The check reported all three
// formats MISSING on a build that had worked. It founds its own directory now, and `Release` is never
// written down: a Debug build would put them somewhere else again.
check('…and FINDS each artifact rather than hardcoding a path the generator owns',
  /Get-ChildItem -Path \$t\.dir -Recurse -Filter \$t\.file/.test(winRun), true);
check('…and never assumes the configuration subdirectory', /Release\//.test(winRun), false);
check('…and packaging finds the files the same way, so the two cannot disagree',
  /Get-ChildItem -Path 'build\/assets' -Recurse -Filter \$z\.file/.test(winRun), true);
check('…and asserts the file is a PE image rather than trusting the extension',
  /0x5A4D/.test(winRun) && /0x00004550/.test(winRun), true);
// ⚠️ dumpbin IS NOT ON PATH ON A WINDOWS RUNNER. The build finished and this step refused to pass, which is
// the behaviour that matters (a check that silently does not run reads as one that passed — H17). It now
// locates the tool with vswhere, so the assertion actually executes rather than being skipped.
check('…and locates dumpbin with vswhere rather than assuming it is on PATH',
  /vswhere/.test(winRun) && /dumpbin could not be located[\s\S]{0,140}Do not let this step pass/.test(winRun), true);
check('…and invokes it by full path, because it is not on PATH to be found by name',
  /&\s*\$dumpbin\.FullName\s+\/nologo\s+\/exports/.test(winRun) && /&\s+dumpbin\s/.test(winRun), false);
check('the artifact spec names the Windows downloads, one per format',
  ['vst3', 'clap', 'standalone'].every((k) => (audioPluginWindows.artifact.glob || '').includes(`plugin-windows-${k}`))
  || ['vst3', 'clap', 'standalone'].every((k) => audioPluginWindows.artifact.verifyCommand.includes(`plugin-windows-${k}`)), true);

const winWf = read('.github/workflows/audio-plugin-windows-build.yml');
check('there is a workflow that builds it on a real Windows runner', winWf.length > 0, true);
check('…dispatched by hand, not on a push or a pull request',
  /on:\s*\n\s+workflow_dispatch:/.test(winWf), true);
check('…and nothing in it can start a Windows bill on every branch',
  /pull_request|^\s*push:/m.test(winWf), false);
check('…on Windows, where MSVC exists', /runs-on: windows-latest/.test(winWf), true);
check('…bounded by a timeout, because configure downloads the SDKs', /timeout-minutes: \d+/.test(winWf), true);
check('…running the target\'s own steps through its runner script',
  /node scripts\/audio-plugin-windows-runner-build\.mjs/.test(winWf), true);
check('…and failing rather than passing with two formats of three', /if-no-files-found: error/.test(winWf), true);
// A manual job nobody knows about is the same as no job (H17) — and with a SHARED project, one dispatch is
// not enough to cover a change: every route has to be built or one of them is proven against stale code.
check('…and every manual audio-plugin job is named in AGENTS.md, so a shared change dispatches all of them',
  /audio-plugin-macos-build\.yml/.test(read('AGENTS.md'))
  && /audio-plugin-windows-build\.yml/.test(read('AGENTS.md'))
  && /audio-plugin-linux-arm-build\.yml/.test(read('AGENTS.md')), true);

const winRunner = read('scripts/audio-plugin-windows-runner-build.mjs');
check('the Windows runner script imports the target and calls its buildSteps',
  /from '\.\.\/server\/src\/lib\/compile-targets\/audio-plugin-windows\.js'/.test(winRunner) && /audioPlugin\.buildSteps\(/.test(winRunner), true);
check('…drives PowerShell, one shell invocation per step',
  /spawnSync\('pwsh', \['-NoProfile', '-Command', step\.run\]/.test(winRunner), true);
check('…refusing to run anywhere but Windows', /process\.platform !== 'win32'/.test(winRunner), true);
check('…and refusing when the standalone was not produced',
  /no \$\{format\} binary was produced[\s\S]{0,200}process\.exit\(1\)/.test(winRunner), true);

console.log('\n15. the LINUX ARM route — the Raspberry Pi, and the one claim only an ARM build can prove');
// WHY THIS ROUTE EXISTS AT ALL. `linux-binary` already builds for Linux; a PLUGIN is different, because it
// is compiled for one instruction set and shipped as a folder. A Pi needs aarch64, and an x86-64 desktop
// needs x86-64 — two different downloads that both say "Linux" on them unless the label says otherwise.
check('it is registered by id and listed', getCompileTarget('audio-plugin-linux-arm')?.id, 'audio-plugin-linux-arm');
check('…and listed in the registry', listCompileTargets().includes('audio-plugin-linux-arm'), true);
check('the label names the PLATFORM and the CPU, not only the formats',
  /Linux/i.test(audioPluginLinux.label) && /ARM/i.test(audioPluginLinux.label), true);
check('…and does NOT promise an Audio Unit, which cannot exist off Apple',
  /AU\b|Audio Unit/i.test(audioPluginLinux.label), false);
check('…and the route is offered in the picker',
  read('src/lib/compileTargets.js').includes(`value: '${audioPluginLinux.id}'`), true);
// ⭐ ONE GENERATOR, THREE ROUTES. This is the anti-drift claim at its widest: if the Linux route generated
// a different project from the macOS one, this guard could pass on both while the Linux build compiled
// something nobody tested.
check('all three routes generate byte-identical projects from one generator',
  JSON.stringify(audioPluginLinux.scaffold(empty).files), JSON.stringify(audioPlugin.scaffold(empty).files));

// The manual's `install` array is the FIRST block a user reads, but the Pi's two surprises are in
// `firstRun` — so this route's section is captured whole rather than only its first list.
const linuxManual = /'audio-plugin-linux-arm': \{[\s\S]*?\n  \},/.exec(manualSrc)?.[0] || '';
check('its manual opens by saying it is Linux ARM only', /LINUX ON ARM \(aarch64\) ONLY/i.test(linuxManual), true);
check('…says why there is no Audio Unit in it', /Audio Unit/i.test(linuxManual), true);
check('…names the install folder a player cannot guess', /\.vst3/.test(linuxManual) && /\.clap/.test(linuxManual), true);
// The two things a Pi user hits that no other platform does, and both look like a broken build.
check('…warns that the standalone needs a desktop, so a headless Pi runs the VST3 or CLAP instead',
  /headless/i.test(linuxManual) && /X11|desktop/i.test(linuxManual), true);
check('…and warns that an x86-64 Linux desktop cannot load it', /x86-64|Intel or AMD/i.test(linuxManual), true);

const linuxSteps = audioPluginLinux.buildSteps(audioPluginLinux.scaffold(empty).files);
const linuxRun = linuxSteps.filter((s) => s.run).map((s) => s.run).join('\n');
check('the build runs in bash and fails fast', /set -euo pipefail/.test(linuxRun), true);
check('…and carries no PowerShell or macOS-only command from the other two routes',
  /\$ErrorActionPreference|sysctl|ditto -c -k|\blipo\b|nm -gU/.test(linuxRun), false);
check('…installing exactly the two packages Linux needs, and no more',
  /libasound2-dev/.test(linuxRun) && /libx11-dev/.test(linuxRun) && !/gtkmm|cairo|fontconfig/.test(linuxRun), true);
check('…configured Release, because a Linux generator is single-config',
  /-DCMAKE_BUILD_TYPE=Release/.test(linuxRun), true);
check('each format is built as its own target, so one failure cannot strand the others',
  /for t in morpheus_plugin_clap morpheus_plugin_vst3/.test(linuxRun) && /morpheus_plugin_standalone/.test(linuxRun), true);
// The Linux layout is neither of the other two, which is the mistake this step exists to prevent.
check('the verification SEARCHES for each artefact rather than building its path',
  /find build\/assets -type f -name "\$file" -print -quit/.test(linuxRun), true);
// ⚠️ TWO TRAPS, BOTH OF WHICH MAKE THIS SCRIPT REPORT THE OPPOSITE OF THE TRUTH, and both are guarded here
// because they are invisible in a green run:
//   * `find | head -n 1` under `set -o pipefail`: head closes the pipe, find takes SIGPIPE, the pipeline is
//     non-zero and `set -e` aborts a search that SUCCEEDED.
//   * `nm ... | grep -q`: grep exits at the first match, nm takes SIGPIPE, the pipeline is non-zero, and the
//     `!` turns a symbol that WAS found into "MISSING ENTRY POINT".
check('…using find -print -quit, not find | head, which trips pipefail when the search succeeds',
  /\| head -n 1/.test(linuxRun), false);
check('…and capturing the symbols once instead of piping nm into grep -q, which does the same in reverse',
  /grep -qw "\$sym" <<< "\$syms"/.test(linuxRun) && !/nm -D --defined-only "\$hit" 2>\/dev\/null \| grep/.test(linuxRun), true);
check('…and asserts the file is an ELF image rather than trusting the extension',
  /7f454c46/.test(linuxRun), true);
// ⭐ THE ASSERTION THE WHOLE ROUTE EXISTS FOR. "This runs on a Raspberry Pi" is only true if the artefact
// was compiled for aarch64, and the likeliest way to break it is to build on the wrong machine.
check('…⭐ and reads the CPU out of the artefact, so a build for the wrong machine cannot pass',
  /readelf -h/.test(linuxRun) && /AArch64/.test(linuxRun) && /WRONG ARCHITECTURE/.test(linuxRun), true);
check('…and asserts the real entry points of the two formats that have them',
  /clap_entry/.test(linuxRun) && /GetPluginFactory/.test(linuxRun), true);
check('the artifact spec names the Linux ARM downloads, one per format',
  ['vst3', 'clap', 'standalone'].every((k) => (audioPluginLinux.artifact.glob || '').includes(`plugin-linux-arm-${k}`))
  || ['vst3', 'clap', 'standalone'].every((k) => audioPluginLinux.artifact.verifyCommand.includes(`plugin-linux-arm-${k}`)), true);
// `zip` stores the path it is handed, so archiving the path `find` returned puts `build/assets/<name>.vst3/…`
// in the archive and a player who unzips it gets a `build/` tree to dig through rather than a plugin folder
// to drag. Both forms were unzipped and compared before this line was written.
check('…and archives the VST3 from inside its own directory, so the archive root is the plugin folder',
  /\( cd build\/assets && zip -qr plugin-linux-arm-vst3\.zip/.test(linuxRun), true);

const linuxWf = read('.github/workflows/audio-plugin-linux-arm-build.yml');
check('there is a workflow that builds it on a real ARM64 Linux runner', linuxWf.length > 0, true);
check('…dispatched by hand, not on a push or a pull request',
  /on:\s*\n\s+workflow_dispatch:/.test(linuxWf), true);
check('…and nothing in it can start a bill on every branch',
  /pull_request|^\s*push:/m.test(linuxWf), false);
// An x86-64 runner here would build a plugin for the wrong machine and every file-exists check would pass.
// Written as "IS the ARM runner AND is not a generic one", because the first version asserted the two
// together against `false` — so setting the runner to `ubuntu-latest` made the first half false and the
// whole check pass. The mutation survived and is what found it.
check('…on an ARM64 runner, which is the only kind that can prove this route',
  /runs-on: ubuntu-24\.04-arm/.test(linuxWf) && !/runs-on: ubuntu-latest/.test(linuxWf), true);
check('…bounded by a timeout, because configure downloads the SDKs', /timeout-minutes: \d+/.test(linuxWf), true);
check('…running the target\'s own steps through its runner script',
  /node scripts\/audio-plugin-linux-arm-runner-build\.mjs/.test(linuxWf), true);
check('…and failing rather than passing with two formats of three', /if-no-files-found: error/.test(linuxWf), true);
check('…and saying in the workflow itself that all three routes must be dispatched after a shared change',
  /ALL THREE/.test(linuxWf) && /audio-plugin-macos/.test(linuxWf) && /audio-plugin-windows/.test(linuxWf), true);

const linuxRunner = read('scripts/audio-plugin-linux-arm-runner-build.mjs');
check('the Linux runner script imports the target and calls its buildSteps',
  /from '\.\.\/server\/src\/lib\/compile-targets\/audio-plugin-linux-arm\.js'/.test(linuxRunner) && /audioPlugin\.buildSteps\(/.test(linuxRunner), true);
check('…drives bash, one shell invocation per step',
  /spawnSync\('bash', \['-c', step\.run\]/.test(linuxRunner), true);
// Both halves of the platform are refused, separately: "wrong OS" and "wrong CPU" are different mistakes,
// and on x86-64 Linux every step would succeed and produce a plugin for the wrong machine.
check('…refusing to run anywhere but Linux', /process\.platform !== 'linux'/.test(linuxRunner), true);
check('…and refusing to run anywhere but ARM64', /process\.arch !== 'arm64'/.test(linuxRunner), true);
// A second, independent read of the same claim: this one reads e_machine out of the ELF header in JS, so a
// `readelf` whose output format changed cannot make the build look correct.
check('…and reading e_machine out of the ELF header itself, not asking readelf again',
  /readUInt16LE\(0x12\)/.test(linuxRunner) && /0xb7/.test(linuxRunner), true);
check('…and refusing when a format was not produced',
  /no \$\{format\} binary was produced[\s\S]{0,200}process\.exit\(1\)/.test(linuxRunner), true);

console.log('\n16. a project carrying a .nam runs the model — and one that does not is the plugin it always was');
// THE STATE WITHOUT A MODEL IS NOT A DEGRADED MODE, it is the plugin that shipped before models existed, and
// every proof taken of it — three runner builds, the test bench, the measured +5.92 dB — stays valid only if
// this stays true. So it is asserted first, and asserted against the shape of the files rather than a summary.
const MODEL_FILES = ['Source/ModelData.h', 'Source/ModelData.cpp'];
const nam = await import('../server/src/lib/namPlugin.js');
const namCli = read('scripts/audio-quantize.mjs');
const LINEAR = '{\n "version": "0.5.4",\n "architecture": "Linear",\n "config": {"receptive_field": 1, "bias": false},\n "weights": [1.0],\n "sample_rate": 48000\n}';
const withModel = [...empty, { path: 'models/amp.nam', content: LINEAR }];

check('a .nam in the project is found, and its architecture is read',
  nam.resolveModel(withModel, { name: 'X' }).info?.architecture, 'Linear');
check('…a project without one resolves to NO model rather than an error',
  nam.resolveModel(empty, { name: 'X' }).info, null);
check('…a model named in the manifest wins over the search',
  nam.resolveModel([...empty, { path: 'models/a.nam', content: LINEAR }, { path: 'other/b.nam', content: LINEAR }], { model: 'other/b.nam' }).path, 'other/b.nam');
// `models/` beats a deeper path, and ties break alphabetically — so a project with two models builds the
// same plugin twice rather than whatever order the file array happened to be in.
check('…and the search is deterministic: models/ first, then the shallowest, then alphabetical',
  nam.resolveModel([...empty, { path: 'src/zz.nam', content: LINEAR }, { path: 'models/aa.nam', content: LINEAR }], {}).path, 'models/aa.nam');
// Scaffolds rather than refuses, like everything else here — but it SAYS so, because a gain plugin with no
// explanation is how a user concludes the feature does not work.
const broken = nam.resolveModel([...empty, { path: 'models/bad.nam', content: '{"architecture":"Linear","weights":[1,null]}' }], { name: 'X' });
check('…a corrupt .nam does not fail the build, it warns and builds the gain stage',
  broken.info === null && broken.warnings.length === 1 && /weight 1 is not a finite number/.test(broken.warnings[0]), true);
check('…and a named model that is not in the project falls back rather than throwing',
  nam.resolveModel(empty, { model: 'models/absent.nam' }).path, null);

for (const withIt of [false, true]) {
  const seed = withIt ? withModel : empty;
  const files = audioPlugin.scaffold(seed).files;
  const header = generated({ files }, 'Source/ModelData.h');
  const data = generated({ files }, 'Source/ModelData.cpp');
  const label = withIt ? 'with a model' : 'without one';
  check(`${label}: both ModelData files are generated`, header.length > 0 && data.length > 0, true);
  check(`${label}: MORPHEUS_HAS_MODEL says ${withIt ? 1 : 0}`,
    header.includes(`#define MORPHEUS_HAS_MODEL ${withIt ? 1 : 0}`), true);
  if (withIt) {
    // ⚠️ THE DECLARATION, NOT ONLY THE DEFINITION. The first version of this pair defined the macros and not
    // the symbols, so the plugin compiled to "use of undeclared identifier 'morpheus_model_data'". Found
    // locally with clang -fsyntax-only before it cost a runner build; asserted here so it cannot come back.
    check('…the header DECLARES the bytes the .cpp defines',
      /extern const unsigned char morpheus_model_data\[\];/.test(header)
      && /const unsigned char morpheus_model_data\[\] = \{/.test(data), true);
    check('…and the model is embedded as the file\'s own bytes, not re-serialised',
      data.includes('0x7b, 0x0a, 0x20, 0x22, 0x76'), true);   // `{\n "v` — the raw .nam text
    check('…with the weight count and byte count in the header',
      /#define MORPHEUS_MODEL_WEIGHTS 1\b/.test(header) && /#define MORPHEUS_MODEL_BYTES \d+/.test(header), true);
  } else {
    check('…and nothing is embedded', /morpheus_model_data\[\] = \{/.test(data), false);
  }
}
// ⭐ THE REASON THE PLUGIN SOURCE IS GENERATED FROM ONE CODE PATH. scripts/audio-testbench.mjs patches the
// gain application out of Source/Plugin.cpp to prove its own checks can fail; if that file's text changed
// shape when a model was present, that proof would depend on what happened to be in the workspace.
check('⭐ the plugin source is byte-identical with a model and without one',
  generated(audioPlugin.scaffold(withModel), 'Source/Plugin.cpp') === generated(audioPlugin.scaffold(empty), 'Source/Plugin.cpp'), true);
check('…it includes ModelData.h unconditionally and every NAM include behind the flag',
  /#include "ModelData.h"/.test(src) && /#if MORPHEUS_HAS_MODEL\n\/\/[\s\S]{0,400}#endif/.test(src)
  && src.indexOf('#include "ModelData.h"') < src.indexOf('get_dsp.h'), true);
check('…and the gain multiply the test bench patches is still written on in_l/in_r',
  (src.match(/in_[lr] \* p->smoothed/g) || []).length >= 2, true);
// The model is per channel because a .nam is mono and the port declaration promises two channels — running
// one instance and copying it would silently collapse a stereo source.
check('…with one model instance PER CHANNEL, so a stereo source is not collapsed to mono',
  /nam::DSP \*model\[2\];/.test(src) && /p->model\[0\]->process/.test(src) && /p->model\[1\]->process/.test(src), true);
// calloc/free runs no destructors, so a smart-pointer member would leak the model every time a host unloads.
check('…released in destroy(), because free() runs no destructors',
  /for \(int c = 0; c < 2; \+\+c\) \{ delete p->model\[c\]; p->model\[c\] = NULL; \}/.test(src), true);
// Reset may allocate and is explicitly not for the audio thread; process() is one frame at a time so the
// per-sample parameter ramp keeps working.
check('…Reset() in activate() and never in process()',
  /plug_activate[\s\S]{0,600}->Reset\(sr, max_buffer\)/.test(src) && /plug_process[\s\S]{0,2000}->Reset\(/.test(src), false);
check('…and a model that will not load degrades to a gain stage with a line in the log',
  /could not load the NAM model from/.test(src), true);

const cmakeWith = generated(audioPlugin.scaffold(withModel), 'CMakeLists.txt');
const cmakeWithout = generated(audioPlugin.scaffold(empty), 'CMakeLists.txt');
check('the CMake compiles the model data either way',
  /add_library\(morpheus_plugin-impl STATIC Source\/Plugin.cpp Source\/ModelData\.cpp\)/.test(cmakeWithout), true);
check('…without a model it mentions no engine at all, so nothing extra is fetched or compiled',
  /MORPHEUS_NAM_DIR|NAM_SAMPLE_FLOAT/.test(cmakeWithout), false);
check('…with one it requires a checkout, globs the engine\u2019s sources and adds both header-only deps',
  /if \(NOT DEFINED MORPHEUS_NAM_DIR\)/.test(cmakeWith)
  && /file\(GLOB MORPHEUS_NAM_SOURCES/.test(cmakeWith)
  && /Dependencies\/eigen/.test(cmakeWith) && /Dependencies\/nlohmann/.test(cmakeWith), true);
// The sample type is chosen by a macro INSIDE the library, so a target that defined it and a library that did
// not would disagree about the signature of the very function the plugin calls.
check('…and pins NAM_SAMPLE_FLOAT, which changes the signature of process() itself',
  /target_compile_definitions\(morpheus_plugin-impl PRIVATE NAM_SAMPLE_FLOAT\)/.test(cmakeWith), true);
// The glob is not a search path: NAMCore's own CMakeLists builds four tools we do not want, and add_subdirectory
// would configure them here.
check('…and does NOT add_subdirectory the engine, which would build its tools',
  /add_subdirectory\(\$\{MORPHEUS_NAM_DIR\}/.test(cmakeWith), false);
// ⭐ ONE ENGINE, BOTH SIDES: the CLI that renders the reference WAV and the plugin that plays the model must
// build the same commit, or the comparison that proves the plugin is between two implementations.
check('⭐ the engine pin is the SAME COMMIT the measurement CLI builds',
  namCli.includes(nam.NAMCORE_REF) && namCli.includes(nam.NAMCORE_REPO.replace(/\.git$/, '')), true);

for (const [route, target] of [['macOS', audioPlugin], ['Windows', audioPluginWindows], ['Linux ARM', audioPluginLinux]]) {
  const off = target.buildSteps(target.scaffold(empty).files);
  const on = target.buildSteps(target.scaffold(withModel).files);
  check(`${route}: nothing is fetched for a model when there is none`,
    !/neural engine/i.test(JSON.stringify(off)) && !/MORPHEUS_NAM_DIR/.test(JSON.stringify(off)), true);
  const step = on.find((s) => /neural engine/i.test(s.name || ''));
  check(`${route}: with one, the pinned engine and its submodules are fetched`,
    Boolean(step) && step.run.includes(nam.NAMCORE_REF) && step.run.includes(nam.NAMCORE_REPO) && /submodule update --init/.test(step.run), true);
  check(`${route}: …and the configure is pointed at that checkout`,
    /MORPHEUS_NAM_DIR=/.test(JSON.stringify(on)), true);
}

const linuxNamRunner = read('scripts/audio-plugin-linux-arm-runner-build.mjs');
check('the runner can build WITH a model, so the model path is proven on hardware and not only in a guard',
  /AUDIO_PLUGIN_MODEL/.test(linuxNamRunner) && /models\/\$\{basename\(modelArg\)\}/.test(linuxNamRunner), true);
check('…and refuses a model path that does not exist rather than spending a build on it',
  /does not exist — refusing to spend a build on it/.test(linuxNamRunner), true);
// ⚠️ ONE JOB, TWO BUILDS, AND `git clone` REFUSES AN EXISTING DIRECTORY. The first run of the modelled build
// died with "destination path .../clap-wrapper already exists" — the workflow's fault, not the steps'. The fix
// keeps the refusal (a clone that reused a stale checkout would build against a different revision than the
// pin) and clears the two checkouts instead, which is what makes the job look like a fresh runner.
check('…and clears the previous run\'s checkouts, because the steps refuse an existing clone and a job now runs twice',
  /for \(const dir of \['clap-wrapper', 'namcore'\]\)/.test(linuxNamRunner)
  && /rmSync\(stale, \{ recursive: true, force: true \}\)/.test(linuxNamRunner), true);
const linuxNamWf = read('.github/workflows/audio-plugin-linux-arm-build.yml');
check('the ARM workflow fetches the example models and builds BOTH shapes',
  /curl[^\n]*\.cache\/models\/[a-z0-9_]+\.nam/.test(linuxNamWf)
  && /--model \.cache\/models\/[a-z0-9_]+\.nam/.test(linuxNamWf)
  && /audio-plugin-linux-arm-nam-build/.test(linuxNamWf), true);
check('…keeping the no-model artifacts too, so the earlier proof is not replaced by the new one',
  /audio-plugin-linux-arm-build\/build\/assets\/\*\.zip/.test(linuxNamWf), true);

console.log('\n17. and the plugin PLAYS the model — the only claim a musician cares about');
// Everything above proves the model is embedded, the engine is linked and the CPU is right. None of it says
// the plugin's OUTPUT is the model's output, so this section covers the render comparison's own machinery:
// the arithmetic, the container, and the two things that would make it compare the wrong pair of signals.
const render = await import('../scripts/audio-nam-render-check.mjs');

const sig = new Float64Array([0.1, -0.2, 0.3, -0.4, 0.5, -0.6]);
check('two identical signals null exactly', render.compareToReference(sig, sig).identical, true);
check('…and report -Infinity, not a number that reads like a floor',
  render.compareToReference(sig, sig).nullDb, -Infinity);
// A 0.1 % amplitude error is -60 dB, so the arithmetic can be checked against a figure worked out by hand
// rather than against whatever the function happens to return.
const scaled = Float64Array.from(sig, (v) => v * 1.001);
check('…a 0.1 % amplitude error measures as -60 dB',
  Math.abs(render.compareToReference(sig, scaled).nullDb + 60) < 0.05, true);
check('…a silent candidate is 0 dB from the reference, not a pass',
  render.compareToReference(sig, new Float64Array(sig.length)).nullDb, 0);
check('…and a shorter candidate is flagged rather than compared over its own length',
  render.compareToReference(sig, sig.subarray(0, 3)).lengthMismatch, true);
// The container. Interleaving is the part that is silently wrong rather than loud: a reader that de-interleaves
// wrongly gives two channels that look plausible and are each other's samples.
const mrawPath = join(tmpdir(), `nam-render-guard-${process.pid}.mraw`);
render.writeMraw(mrawPath, 48000, 2, new Float32Array([1, 2, 3, 4, 5, 6]));
const back = render.readMraw(mrawPath);
check('the MRAW container round-trips rate, channels and frames',
  [back.sampleRate, back.channels, back.frames], [48000, 2, 3]);
check('…and de-interleaves, so left is 1,3,5 and right is 2,4,6',
  [Array.from(back.data[0]), Array.from(back.data[1])], [[1, 3, 5], [2, 4, 6]]);
unlinkSync(mrawPath);

// ⚠️ LIKE FOR LIKE, OR THE COMPARISON MEASURES THE WRONG THING. The plugin pins NAM_SAMPLE_FLOAT; NAMCore's
// own render tool defaults to double. A float plugin against a double reference would report the precision
// choice as though it were a wiring bug, so BOTH compile lines carry the flag.
const renderSrc = read('scripts/audio-nam-render-check.mjs');
// One shared flag list, spread into every compile — so a build that dropped the standard or the sample type
// would be a visible edit rather than a missing argument. Both omissions happened: the two-step compile was
// first written with the sample flag alone, and clang answered "no template named 'optional' in namespace
// 'std'" seventeen times.
check('every side is built with the SAME standard and the SAME sample type the plugin pins',
  /const COMPILE_FLAGS = \['-std=c\+\+20', '-O2', '-w', '-DNAM_SAMPLE_FLOAT'\];/.test(renderSrc)
  && (renderSrc.match(/\.\.\.COMPILE_FLAGS/g) || []).length, 3);
check('…and the reference is built from the SAME engine checkout the plugin uses, not a second copy',
  /join\(namcore, 'tools', 'render\.cpp'\)/.test(renderSrc), true);
// ⚠️ TWO FILES IN THAT TREE ARE CALLED `wav.h`: the engine's (`nam::detail`) and the tool's (`dsp::wav`). One
// include order cannot serve both, and the first version of this file compiled them together and failed with
// "`dsp` has not been declared" — so the engine's translation units and the tool's are compiled separately,
// each with its own order, and the objects are linked after.
check('…with its OWN include order, because two files in that tree are called wav.h',
  /join\(adt, 'wav\.cpp'\)/.test(renderSrc) && /`-I\$\{adt\}`/.test(renderSrc), true);
// BOTH GROUPS CONTAIN A FILE CALLED wav.cpp, so a shared object directory writes one `wav.o` over the
// other's and the link fails on `nam::detail::load_wav_ir` — a missing engine symbol caused by a filename
// collision. The two groups compile into separate directories and the objects are linked after.
check('…into SEPARATE object directories, because both groups contain a wav.cpp',
  /const objNam = join\(work, 'obj-nam'\);/.test(renderSrc)
  && /const objTool = join\(work, 'obj-tool'\);/.test(renderSrc)
  && /\[objNam, objTool\]\.flatMap/.test(renderSrc), true);
// The plugin processes one frame at a time and `render` processes blocks. Pinning both to the same block size
// removes the one difference between the two paths that has nothing to do with the plugin's correctness.
check('…and the two paths are told to use the same block size',
  render.REFERENCE_BLOCK_SIZE, 64);
check('…which the host is actually given',
  /'--blocksize', String\(REFERENCE_BLOCK_SIZE\)/.test(renderSrc), true);
// The dry signal is written as a WAV for the reference tool and as a stereo MRAW for the host, from ONE array.
check('…and both renders are of the same samples, written twice rather than generated twice',
  /const dry = withFades\(logSweep/.test(renderSrc)
  && /writeFileSync\(dryWav, encodeWav\(\{ sampleRate, data: dry/.test(renderSrc)
  && /writeMraw\(dryMraw, sampleRate, 2, stereo\)/.test(renderSrc), true);
// The headers are pinned, for the same reason the test bench pins them.
check('the CLAP headers are pinned, fetched once into .cache, and can be overridden',
  render.CLAP_REF.length === 40 && /CLAP_INCLUDE/.test(renderSrc) && /\.cache/.test(renderSrc), true);

const armRunnerSrc = read('scripts/audio-plugin-linux-arm-runner-build.mjs');
check('the ARM runner runs the comparison when asked, and only with a model',
  /if \(renderCheck\) \{/.test(armRunnerSrc) && /--render-check needs a model/.test(armRunnerSrc), true);
check('…refusing when the engine checkout is missing rather than silently skipping the proof',
  /--render-check needs the engine checkout/.test(armRunnerSrc), true);
// ⭐ A MODEL THAT DOES NOTHING WOULD PASS EVERY NULL TEST. The reference render is compared to the DRY signal
// as well: if the model barely changes it, the two renders agree because they are two copies of the same file.
// Asserted as the CONDITION, not as the words: the first version checked only that `expect-model-effect-db`
// and the message appeared somewhere in the file, and the mutation that replaced the condition with `if
// (false)` left both of them in place — so it survived, which is the mutation harness doing its job.
check('⭐ the comparison is refused when the model does not actually change the signal',
  /if \(Number\.isFinite\(expectEffectDb\) && !\(result\.dryVsReference\.nullDb > expectEffectDb\)\) \{/.test(armRunnerSrc)
  && /a null test against it would prove nothing/.test(armRunnerSrc), true);
check('…and the workflow renders the real WAVENET, not the identity model that would prove nothing about the engine',
  /--model \.cache\/models\/wavenet_a1_standard\.nam/.test(linuxNamWf)
  && /--render-check/.test(linuxNamWf)
  && /--expect-model-effect-db/.test(linuxNamWf), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ the audio-plugin target can generate a project that will not build\n');
  process.exit(1);
}
console.log('the audio-plugin target generates a project that builds, loads, and has working parameters\n');
