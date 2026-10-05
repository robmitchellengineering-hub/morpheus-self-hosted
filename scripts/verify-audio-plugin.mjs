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
// EIGHT RATHER THAN FOUR, and every pair is there for the same reason: `ModelData.{h,cpp}` and
// `CabIr.{h,cpp}` are generated for EVERY project, including one that has neither a model nor a cabinet,
// because the plugin includes their headers unconditionally and branches on the flags inside. That is what
// keeps Source/Plugin.cpp the same text whatever the workspace holds.
check('it generates exactly the eight files the build needs',
  s.generated.slice().sort(), ['CMakeLists.txt', 'Source/CabIr.cpp', 'Source/CabIr.h', 'Source/ModelData.cpp', 'Source/ModelData.h', 'Source/Plugin.cpp', 'Source/PluginEntry.cpp', PLUGIN_MANIFEST]);
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
// ⚠️ NO LINE MAY HOLD MORE THAN ONE ESCAPE SEQUENCE. The blanket form of this check — "no `\\n` anywhere" —
// was right about the bug and wrong about shell: `tr '\\n' ' '` inside the parameters line is a deliberate
// newline translation, and a text check cannot tell it from a collapsed script. What a collapse actually
// produces is MANY escapes on ONE line, which this catches, and the line count below is the direct assertion.
check('no rendered line collapsed a script into escape sequences',
  yaml.split('\n').every((l) => (l.match(/\\n/g) || []).length <= 1), true);
// …and the specific step that was collapsed, named, so a failure says where to look. Counted rather than
// pattern-matched: `run: |` alone is satisfied by a block scalar holding one enormous line.
const verifyBlock = yaml.slice(yaml.indexOf('name: Verify every bundle'), yaml.indexOf('name: Package'));
check(`the verification step is a real multi-line script, not one line (${verifyBlock.split('\n').length} lines)`,
  /name: Verify every bundle contains its binary\n\s+run: \|/.test(yaml) && verifyBlock.split('\n').length >= 25, true);
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
// ⚠️ THE PIN MOVED AND THIS GUARD HAD TO FOLLOW IT. It used to be inlined in scripts/audio-quantize.mjs;
// the capture work needed the same engine, so it now lives in scripts/lib/referenceEngine.mjs and both CLIs
// import it. Reading only the CLI would have gone ON A MISSING PIN — `includes` on a file that no longer
// mentions it is false, which is the right colour for the wrong reason — so the assertion reads the module
// that holds it. It failed here the moment the move happened, which is the behaviour it is for.
const namEngine = read('scripts/lib/referenceEngine.mjs');
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

// ── ⭐ NAM A2 IS A CONTAINER, AND THE FORMAT WAS REJECTED BY A GATE ON ONE FORMAT ────────────────────────
// A `SlimmableContainer` is SEVERAL submodels of one amp at different sizes, chosen at runtime, with its
// weights in `config.submodels[].model` and the top-level `weights` deliberately empty. Measured against
// NeuralAmpModelerCore 0b3d3c9: `A2.nam` is exactly that and the engine loads it happily, so the engine was
// never the problem — `inspectModel`'s flat-weight requirement was, and it reports "has no weights array",
// which reads like a corrupt file rather than like a format we do not handle.
//
// The assertions below are the two halves of getting that right: a container must be ACCEPTED, and it must
// not become a hole through which a null weight reaches the plugin — which is the one thing the flat check
// existed to stop, and a container is where a truncated file is hardest to notice because the total still
// looks plausible.
const CONTAINER = (subs) => JSON.stringify({
  version: '0.5.4', architecture: 'SlimmableContainer', sample_rate: 48000,
  config: { submodels: subs },
});
const sub = (maxValue, weights, architecture = 'WaveNet') => ({ max_value: maxValue, model: { architecture, weights } });

const container = nam.resolveModel([...empty, { path: 'models/a2.nam', content: CONTAINER([sub(0.5, [1, 2, 3]), sub(1.0, [4, 5, 6, 7, 8])]) }], { name: 'X' });
check('a SlimmableContainer is accepted rather than refused as corrupt', Boolean(container.info), true);
check('…and is reported as a container, not as whatever the last submodel happened to be',
  container.info?.architecture, 'SlimmableContainer');
check('…with the TOTAL weight count', container.info?.weights, 8);
check('…and one entry per submodel, so a caller can see the size dial it is getting',
  container.info?.submodels?.map((m) => m.weights), [3, 5]);
check('…and its thresholds, which are the dial positions', container.info?.submodels?.map((m) => m.maxValue), [0.5, 1]);
check('…flagged as resizable, which is what makes one file a quality/CPU dial', container.info?.slimmable, true);
check('…and a flat model says it is NOT slimmable rather than leaving the field absent',
  nam.resolveModel(withModel, { name: 'X' }).info?.slimmable, false);

// The hole the flat check existed to close, kept closed for containers.
const badSub = nam.resolveModel([...empty, { path: 'models/bad.nam', content: CONTAINER([sub(0.5, [1, 2]), sub(1.0, [3, null])]) }], { name: 'X' });
check('a null weight inside a submodel is still caught', badSub.info, null);
check('…and named by submodel, so the message says where to look',
  /submodel 1 weight 1 is not a finite number/.test(badSub.warnings[0] || ''), true);
check('an empty container is refused as a container, not as a missing weights array',
  /SlimmableContainer with no submodels/.test(nam.resolveModel([...empty, { path: 'models/e.nam', content: CONTAINER([]) }], { name: 'X' }).warnings[0] || ''), true);
check('…and a submodel with no weights in it too',
  /submodel 0 has no weights array/.test(nam.resolveModel([...empty, { path: 'models/e2.nam', content: CONTAINER([{ max_value: 1, model: { architecture: 'WaveNet' } }]) }], { name: 'X' }).warnings[0] || ''), true);

// ── the instrument that produced the numbers, and the two ways it could report a wrong one ──────────────
// The bench exists so a throughput comparison is reproducible on one machine in one run. It compiles ONCE and
// runs the binary per model — recompiling the engine per model is a minute each and it was the first thing
// this got wrong.
const benchSrc = read('scripts/audio-model-bench.mjs');
check('the bench times the engine\'s own process loop', /processStart|t0 = std::chrono::steady_clock::now\(\)/.test(benchSrc)
  && /for \(int done = 0; done < total; done \+= block\)/.test(benchSrc), true);
check('…after a warm-up, so the first blocks are not what is measured', /for \(int i = 0; i < 200; i\+\+\) model->process/.test(benchSrc), true);
check('…uses the engine\'s own slimmable interface rather than guessing at the file',
  /dynamic_cast<nam::SlimmableModel\*>/.test(benchSrc) && /SetSlimmableSize/.test(benchSrc), true);
check('…and reports a model the engine will not load as UNLOADABLE, never as a slow one',
  /error/.test(benchSrc) && /get_dsp/.test(benchSrc), true);
check('…compiles the engine once, not once per model',
  (benchSrc.match(/compile\(\[/g) || []).length === 1, true);
check('the bench refuses to run without a checkout instead of reporting nothing',
  /no engine checkout at/.test(benchSrc), true);


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
// The line scripts/audio-testbench.mjs patches to prove its own checks can fail. It moved when the
// parameter list became a table — the output level is now one entry in `smoothed[]` — and the test bench's
// own count is what catches that, but this asserts the shape too so the two cannot drift apart quietly.
check('…and the gain multiply the test bench patches is still written on in_l/in_r',
  (src.match(/in_[lr] \* db_to_linear\(p->smoothed\[IDX_OUTPUT\]\)/g) || []).length >= 2, true);
// The model is per channel because a .nam is mono and the port declaration promises two channels — running
// one instance and copying it would silently collapse a stereo source.
// The chain runs one channel at a time through the same code, indexed by the loop variable — so it is
// structurally impossible to send both channels through one instance, which is what a stereo image that
// moves when a control does looks like.
check('…with one model instance PER CHANNEL, so a stereo source is not collapsed to mono',
  /nam::DSP \*model\[2\];/.test(src) && /for \(int c = 0; c < 2; \+\+c\) \{/.test(src)
  && /p->model\[c\]->process/.test(src), true);
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
check('the CMake compiles the generated data files either way',
  /add_library\(morpheus_plugin-impl STATIC Source\/Plugin\.cpp Source\/ModelData\.cpp Source\/CabIr\.cpp\)/.test(cmakeWithout), true);
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
  namEngine.includes(nam.NAMCORE_REF) && namEngine.includes(nam.NAMCORE_REPO.replace(/\.git$/, '')), true);

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

// ⭐ THE DEVICE QUESTION, which every other number in this file is silent about: not "is the plugin RIGHT" but
// "does it FIT". A model that only just beats real time on a runner does not beat it on a Raspberry Pi, whose
// core is slower and whose audio thread shares the board with everything else.
//
// The arithmetic is checked against figures worked out by hand, because THE DIRECTION IS THE WHOLE ANSWER: the
// factor is wall time over audio time, so below 1 is faster than real time. An inverted division reads as a
// comfortable pass on a machine that cannot keep up — which is the one way this could be actively misleading
// rather than merely absent.
check('half a second of CPU for a second of audio is real-time factor 0.5',
  render.realTimeFactor({ processSeconds: 0.5, audioSeconds: 1 }).realTimeFactor, 0.5);
check('…which is twice as fast as real time, not half',
  render.realTimeFactor({ processSeconds: 0.5, audioSeconds: 1 }).timesFaster, 2);
check('two seconds of CPU for one of audio is SLOWER than real time (factor 2, not 0.5)',
  render.realTimeFactor({ processSeconds: 2, audioSeconds: 1 }).realTimeFactor, 2);
check('…and a render with no audio in it is not given a factor at all',
  render.realTimeFactor({ processSeconds: 1, audioSeconds: 0 }), null);

// The host prints two JSON lines — the plugin's identity, then the timing — and the parse has to find the
// second without being fooled by the first. Reading the identity line as the timing would report a throughput
// of `undefined`, and `undefined < 1` is false, so the check would pass on a run that measured nothing.
const hostOut = '{"id":"x","params":[]}\n{"processSeconds":0.5,"audioSeconds":4,"frames":192000,"sampleRate":48000,"blockSize":64}\n';
check('the host\'s timing is read from the second JSON line, not the first',
  render.parseHostTiming(hostOut), { processSeconds: 0.5, audioSeconds: 4, frames: 192000, sampleRate: 48000, blockSize: 64 });
check('…and stdout with no timing line in it is null, not a guess',
  render.parseHostTiming('{"id":"x","params":[]}\n'), null);
check('…and a truncated timing line is skipped rather than half-read',
  render.parseHostTiming('{"processSeconds":0.5,"audioSe\n'), null);
check('…and no stdout at all is null', render.parseHostTiming(''), null);

// The number has to come from the plugin's own process() loop, not from a stopwatch around the process. A
// timing taken from JS mostly measures process startup and the file read on a quarter-second render, and it
// would be reported as the model's throughput.
const hostSrc = read('tools/clap-offline/clap_offline.cpp');
check('the host times its own process loop', /steady_clock::now\(\)/.test(hostSrc) && /processStart/.test(hostSrc), true);
// The C++ source carries them as escaped quotes inside a printf format, so the literal to look for is
// \"processSeconds rather than "processSeconds — the first version of this check looked for the latter and
// failed on a host that prints exactly the right thing.
check('…and prints the seconds and the audio it was worth, on stdout',
  /\\"processSeconds/.test(hostSrc) && /\\"audioSeconds/.test(hostSrc), true);
check('…timed around the loop and not around the load', (() => {
  const start = hostSrc.indexOf('processStart = std::chrono::steady_clock::now()');
  const loop = hostSrc.indexOf('while (done < in.frames)');
  const end = hostSrc.indexOf('processEnd = std::chrono::steady_clock::now()');
  return start > 0 && loop > start && end > loop;
})(), true);

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

// The throughput number is only useful if something refuses a bad one. Both halves are asserted here because
// either alone leaves a measurement that is reported and then ignored — H17's shape, where a check that cannot
// fail reads as a check that passed.
// ⚠️ THE MODEL AND THE ENGINE THAT PLAYS IT COME FROM ONE COMMIT. The engine is pinned to NAMCORE_REF, and
// fetching the example models from `main` means a model can arrive that the pinned engine cannot load — the
// same class of failure as the one just fixed from the other side, where our generator refused a format the
// engine supported. A pin that only half the workflow honours is not a pin.
check('the workflow fetches its example models from the SAME commit as the engine',
  linuxNamWf.includes(`NeuralAmpModelerCore/${nam.NAMCORE_REF}/example_models`), true);
// The device tier is being decided on NAM A2, which is a container with a runtime size dial — so the workflow
// has to both carry it and walk the dial, or the number that decides the tier is for one end of it only.
check('…and carries NAM A2\'s own container model, not just the A1 it was built around',
  /\.cache\/models\/A2\.nam/.test(linuxNamWf), true);
check('…and measures the size dial rather than one end of it', /--slim 0\.0,1\.0/.test(linuxNamWf), true);
check('…and proves the PLUGIN plays a container, which the engine-level bench does not',
  /--model \.cache\/models\/A2\.nam/.test(linuxNamWf) && /--render-check/.test(linuxNamWf), true);
check('the render check fails a CPU that cannot beat real time', /realTimeFactor >= maxRtf/.test(renderSrc), true);
check('…and the runner build refuses it too, before anything is published',
  /realTimeFactor < 1/.test(armRunnerSrc), true);
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

console.log('\n18. the amp chain: a table of parameters, and a tone stack measured against its design');
const chainMod = await import('../server/src/lib/ampChain.js');

// ⭐ A CHAIN IS DATA, AND EVERY STAGE CARRIES AN IDENTITY THAT IS NOT ITS POSITION. The pedalboard work
// reads `instanceId` out of PiPedal's model for the same reason, and it is the one decision that corrupts
// silently if it arrives late: anything keyed by position — a saved value, a MIDI binding, a host's
// automation lane — follows the WRONG block the moment a user drags one past another. There is nothing to
// break yet, which is exactly when it is cheap.
for (const chain of [chainMod.PLAIN_CHAIN, chainMod.AMP_CHAIN]) {
  const stages = chain.stages || [];
  check(`${chain.name}: the chain IS a list of stages`, stages.length > 0, true);
  check(`${chain.name}: every stage says what it does`, stages.every((st) => typeof st.kind === 'string' && st.kind.length > 0), true);
  check(`${chain.name}: every stage has a NON-EMPTY id`, stages.every((st) => typeof st.id === 'string' && st.id.length > 0), true);
  check(`${chain.name}: the ids are unique, so identity survives a reorder`,
    new Set(stages.map((st) => st.id)).size, stages.length);
}
// THE SPLIT IS DERIVED, WHICH IS THE POINT OF THE WHOLE SHAPE. The model runs a block at a time, so the loop
// is three passes — and that was an AMP's shape bolted into the template. A chain with no model has no
// middle, which is what makes a delay or a reverb expressible without arguing with an amp.
check('the model is a stage with stages before it', chainMod.modelStageIndex(chainMod.AMP_CHAIN) > 0, true);
check('…and a chain with no model has no middle', chainMod.modelStageIndex(chainMod.PLAIN_CHAIN), -1, true);
check('…which the emitters ask rather than assume', chainMod.chainHas(chainMod.PLAIN_CHAIN, 'model'), false, true);
check('the parameters are DERIVED from the stages, in the stages\' own order',
  chainMod.chainParams(chainMod.AMP_CHAIN, {}).map((pp) => pp.key), ['input', 'gate', 'bass', 'mid', 'treble', 'output']);
check('…and the plain chain still calls its single control what the manifest says',
  chainMod.chainParams(chainMod.PLAIN_CHAIN, { paramName: 'Drive' }).map((pp) => pp.name), ['Drive']);
const tone = await import('../server/src/lib/audio/toneStack.js');

// ── the design, which is what the plugin is measured against ───────────────────────────────────────────
const SR = 48000;
const flat = tone.toneDesign({ gains: {}, sampleRate: SR });
check('a flat tone stack is 0 dB at every probe frequency',
  [20, 100, 800, 3000, 15000].every((f) => Math.abs(tone.toneResponseDb(flat, f, SR)) < 0.01), true);
// Worked out from the RBJ formulas rather than read back off the implementation: a low shelf at +12 dB with
// its corner at 100 Hz is a little over +11 dB at 50 Hz, not +12 — that is what a shelf does, and a check
// asserting "+12" would have been asserting the wrong thing.
const bassUp = tone.toneDesign({ gains: { bass: 12 }, sampleRate: SR });
const bassAt50 = tone.toneResponseDb(bassUp, 50, SR);
check('a +12 dB bass shelf raises 50 Hz by a little over 11 dB, and leaves 6 kHz alone',
  bassAt50 > 10.5 && bassAt50 < 11.5 && Math.abs(tone.toneResponseDb(bassUp, 6000, SR)) < 0.05, true);
const trebleUp = tone.toneDesign({ gains: { treble: 12 }, sampleRate: SR });
check('…and the treble shelf does the mirror image',
  tone.toneResponseDb(trebleUp, 6000, SR) > 10.5 && Math.abs(tone.toneResponseDb(trebleUp, 50, SR)) < 0.05, true);
check('the bands are the ones the plugin is generated from — same keys, same order',
  tone.TONE_KEYS.join(','), chainMod.chainParams(chainMod.AMP_CHAIN, {}).filter((p) => p.role === 'tone').map((p) => p.key).join(','));

// ── what the plugin asks for ───────────────────────────────────────────────────────────────────────────
check('a project that asks for nothing gets the single-parameter plugin', chainMod.chainFor({}).name, 'plain');
check('…an unknown chain is not silently the amp', chainMod.chainFor({ chain: 'marshall' }).name, 'plain');
check('…and "amp" is the chain this version knows, case-insensitively', chainMod.chainFor({ chain: ' AMP ' }).name, 'amp');
const ampSeed = [...empty, { path: PLUGIN_MANIFEST, content: JSON.stringify({ name: 'Amp', chain: 'amp' }) }];
const ampFiles = audioPlugin.scaffold(ampSeed).files;
const ampSrc = generated({ files: ampFiles }, 'Source/Plugin.cpp');
const plainSrc = src;
// Six since the gate landed, and the ids are asserted as a SEQUENCE because inserting a stage in the middle
// renumbers everything after it — which is how the measurement's hardcoded parameter ids went stale.
check('the amp chain is input, gate, three tone bands, output',
  (ampSrc.match(/PARAM_\w+ = \d+/g) || []).join(' '),
  'PARAM_INPUT = 1 PARAM_GATE = 2 PARAM_BASS = 3 PARAM_MID = 4 PARAM_TREBLE = 5 PARAM_OUTPUT = 6');
check('…and the plain plugin still has exactly one, so nothing that predates this changed',
  (plainSrc.match(/PARAM_\w+ = \d+/g) || []).join(' '), 'PARAM_OUTPUT = 1');
check('…and the plain plugin carries no tone code at all', /biquad_process/.test(plainSrc), false);
check('…and the amp plugin does', /biquad_process/.test(ampSrc) && /biquad_set/.test(ampSrc), true);
// The corner frequencies and Q values are emitted FROM the design, so a change to one is a change to both.
check('every band\u2019s frequency, Q and filter type is emitted from the design',
  tone.TONE_BANDS.every((b) => ampSrc.includes(`${Number(b.freq)}.0, ${Number(b.q)}`))
  && /TONE_LOWSHELF/.test(ampSrc) && /TONE_PEAK/.test(ampSrc) && /TONE_HIGHSHELF/.test(ampSrc), true);
// ⚠️ The threshold is 1e-6 because 0.001 dB of coefficient error measured as -55 dB of residual against the
// design. That number is why it is where it is, and it is asserted so it cannot drift back.
check('the coefficients are recomputed on a millionth of a decibel, not on a thousandth',
  /#define MORPHEUS_TONE_EPS 0\.000001/.test(ampSrc), true);
check('…and the filter state is per channel, so the two channels cannot bleed',
  /biquad_t tone\[2\]\[/.test(ampSrc) && /biquad_process\(&p->tone\[c\]/.test(ampSrc), true);
// The chain's ORDER is the musical one and it is easy to get backwards: output last means the level control
// does not change how hard the model is driven.
// Compared INSIDE the process function, not across the whole file: `IDX_OUTPUT` is also a #define near the
// top, so a whole-file index comparison passes with the multiply wherever it happens to be — which is how
// the first version of this check passed on the wrong code.
const ampLoop = ampSrc.slice(ampSrc.indexOf('static clap_process_status plug_process'));
const ampLoopTail = ampLoop.slice(0, ampLoop.indexOf('static const void *plug_get_extension'));
check('the output level is applied AFTER the model, so it cannot act as a drive control',
  ampLoopTail.indexOf('p->model[c]->process') < ampLoopTail.lastIndexOf('IDX_OUTPUT'), true);
check('…and the input trim BEFORE it', ampLoopTail.indexOf('IDX_INPUT') < ampLoopTail.indexOf('p->model[c]->process'), true);
// ⚠️ AND APPLIED EXACTLY ONCE. It was emitted twice — once inside the channel loop and once on the final
// line — and a +6 dB setting measured +11.85 dB. An existing check in the test bench caught it, which is the
// argument for the bench; this asserts the count so the generator cannot reintroduce it.
check('…and exactly ONCE, which is the mistake that measured a +6 dB setting as +11.85 dB',
  (ampLoopTail.match(/db_to_linear\(p->smoothed\[IDX_OUTPUT\]\)/g) || []).length, 2);
// A guard on the guard: the model block is still behind the flag, so the source stays identical with and
// without one — the property the test bench's self-test depends on.
// ⚠️ ANCHORED ON THE CHAIN'S OWN COMMENT, not on `#if MORPHEUS_HAS_MODEL` followed somewhere by
// `if (p->model[c])` — the first version of this check was the loose form, and it PASSED with the chain's
// flag removed, because plug_activate has the same two strings within 400 characters of each other. The
// mutation survived, which is how the check was found to be measuring the wrong region.
// The anchor moved with the model block when the model became a BLOCK call (see below): it now lives in the
// template's process loop rather than in the chain text, and the comment it is anchored on changed with it.
// The property is unchanged and so is the reason for anchoring on a COMMENT rather than on the two pragma
// strings — a loose match passed with the flag removed because plug_activate contains both of them.
check('…and the model is still behind the flag, so the source does not change with one',
  /#if MORPHEUS_HAS_MODEL\n\s*\/\/ ── THE MODEL, ONCE PER CHUNK PER CHANNEL/.test(ampSrc), true);

// ⭐ THE ENGINE IS CALLED ONCE PER BLOCK, NOT ONCE PER SAMPLE — and this is the assertion that keeps it that
// way, because the regression is silent: one sample at a time produces the SAME audio and simply costs 2.6x
// more CPU. Measured here with the plugin built both ways, 4 s of audio in 64-frame blocks on one machine:
//
//     one sample at a time   3.3775 s CPU   1.18x real time   -144.0 dB vs the reference
//     once per block         1.2855 s CPU   3.11x real time   EXACT vs the reference
//
// The per-sample calls were not merely slow: they were the entire reason the null was -144 dB instead of
// exact, so the "worse" number was being reported as the plugin's accuracy.
check('⭐ the model is called ONCE PER BLOCK, not once per sample',
  /p->model\[c\]->process\(io, io, model_frames\)/.test(ampSrc), true);
check('…with the chunk it was given, and the count is that and not a literal 1',
  /const int model_frames = \(int\)\(chunk_end - chunk_start\);/.test(ampSrc)
  && !/->process\(mip, mop, 1\)/.test(ampSrc), true);
// IN PLACE, which is what removes the need for a scratch buffer, an allocation and a field in plugin_t. It is
// only sound while NAM_SAMPLE is float, and a cast between float and double is undefined behaviour rather
// than a compile error — so the cast is guarded by a static_assert that makes it one.
check('…in place on the float32 port, with the cast made a compile error if NAM_SAMPLE stops being float',
  /NAM_SAMPLE \*io\[1\] = \{\(NAM_SAMPLE \*\)process->audio_outputs\[0\]\.data32\[c\]/.test(ampSrc)
  && /static_assert\(sizeof\(NAM_SAMPLE\) == sizeof\(float\)/.test(ampSrc), true);
// AND THE OUTPUT RAMP STAYS PER-SAMPLE. Pass 1 deliberately skips IDX_OUTPUT so that pass 2 can step it where
// the output is applied; stepping it in both would double its rate, and stepping it only in pass 1 would run
// it a block ahead. Both are silent.
check('the output smoother is stepped ONCE per sample, in the pass that applies it',
  /if \(k == IDX_OUTPUT\) continue;/.test(ampSrc)
  && /p->smoothed\[IDX_OUTPUT\] \+= \(p->value\[IDX_OUTPUT\] - p->smoothed\[IDX_OUTPUT\]\) \* 0.001;/.test(ampSrc), true);
// The measurement is the justification for the shape, and it is in the generated source so the next person to
// touch this loop reads the number rather than the opinion.
check('…and the generated source carries the measurement that justifies the shape',
  /2\.58x/.test(ampSrc) && /8\.85x/.test(ampSrc), true);
check('an unknown chain warns instead of quietly building something else',
  audioPlugin.scaffold([...empty, { path: PLUGIN_MANIFEST, content: JSON.stringify({ name: 'X', chain: 'marshall' }) }])
    .warnings.some((w) => /does not have/.test(w)), true);

// ── and the check that measures it ─────────────────────────────────────────────────────────────────────
const chainCheckSrc = read('scripts/audio-amp-chain-check.mjs');
check('there is a check that renders the chain and compares it to the design', chainCheckSrc.length > 1500, true);
check('…it exercises each band on its own, so two filters wired to one band cannot pass',
  ['bass', 'mid', 'treble'].every((k) => chainCheckSrc.includes(k)), true);
// The parameters ramp, so the comparison reads the SETTLED tail — comparing the whole file measures the ramp
// (that was -55 dB) rather than the filters (which is better than -140 dB).
check('…and it compares the settled tail, not the ramp', /SETTLE_FRACTION = 0\.75/.test(chainCheckSrc), true);
const chainThreshold = chainCheckSrc.match(/arg\('max-null-db', '(-?\d+)'\)/);
check('…with a threshold the measured numbers actually clear',
  Boolean(chainThreshold) && Number(chainThreshold[1]) <= -120, true);
// The bench's self-test proves the bench can fail by breaking the plugin's output gain. It finds that line by
// shape, so if the plugin's shape moves and the bench's pattern does not, the self-test silently stops
// patching anything — the bench would then pass a broken plugin and report that as proof it works.
check('…and the test bench patches that same shape as the plugin now emits',
  /APPLIED_GAIN = \/in_\[lr\] \\\* db_to_linear\\\(p->smoothed\\\[IDX_/.test(read('scripts/audio-testbench.mjs')), true);

console.log('\n19. the build explains itself: a proof file, written by the build, shipped with the download');
// Rob, 2026-10-05: *"I can see any of the things we've done, have they landed, where are they?"* The evidence
// all existed and none of it could be seen — it lived in an Actions log. This file puts it beside the
// artifact, in the one place a user already looks.
const proof = await import('../server/src/lib/buildProof.js');
check('the proof file has one name, from one constant',
  proof.BUILD_PROOF_FILE, 'BUILD-PROOF.txt');
// ⚠️ THE FIXED PART MUST CARRY NO FACTS. A header written from the generator's template would say "AArch64"
// for a build that produced an x86-64 plugin, and say it convincingly — the whole value of the file is that
// every line under "verified" was measured by the step that checked it.
const proofHeaderText = proof.proofHeader({ target: 'audio-plugin-linux-arm', targetLabel: 'X' });
check('its header describes the file and claims nothing about the build',
  /written by the build/i.test(proofHeaderText)
  && !/AArch64|x86_64|PE image|bytes/.test(proofHeaderText), true);
// The facts are appended, and the append comes AFTER the failure check in every route — a build that cannot
// verify a format fails instead of publishing a proof with the line missing.
const proofTargets = [
  ['Linux ARM', audioPluginLinux, 'Verify every format is a real plugin binary for this machine'],
  ['macOS', audioPlugin, 'Verify every bundle contains its binary'],
  ['Windows', audioPluginWindows, 'Verify every format is a real plugin binary'],
];
for (const [route, target, stepName] of proofTargets) {
  const steps = target.buildSteps(target.scaffold(empty).files);
  const verify = (steps.find((x) => x.name === stepName) || {}).run || '';
  check(`${route}: the proof file is declared for release`, target.artifact.proofFile, proof.BUILD_PROOF_FILE);
  check(`${route}: …and the step writes it`, verify.includes(proof.BUILD_PROOF_FILE), true);
  const guarded = /did not produce usable plugins|MISSING BUNDLE/.test(verify);
  check(`${route}: …AFTER the failure check, so an unverified build publishes nothing`,
    guarded && verify.indexOf(proof.BUILD_PROOF_FILE) > verify.search(/did not produce usable plugins|MISSING BUNDLE/), true);
  check(`${route}: …from the same values the assertions used, not from a second look`,
    /proof_/.test(verify) && verify.split('\n').length > 20, true);
  // Printed to the job log as well as published: a run's own record is the other place someone looks, and a
  // proof that only exists as a download is one you have to go and fetch before you can read it.
  check(`${route}: …and echoed into the run's log`, /cat BUILD-PROOF\.txt|Get-Content/.test(verify), true);
  // A BUILD WITH NO MODEL IS A SUPPORTED STATE, and the file has to say so. The first version printed the
  // heading and then nothing, because `sed` exits 0 when it matches nothing — an empty line under a heading
  // reads as a fact that went missing. Seen in the real ARM run's proof.
  check(`${route}: …and says so explicitly when the plugin carries no model`,
    /this is the gain plugin/.test(verify), true);
}
check('every format the Linux route promises is named in its proof',
  audioPluginLinux.buildSteps(audioPluginLinux.scaffold(empty).files)
    .filter((x) => x.run).map((x) => x.run).join('\n')
    .match(/check (CLAP|VST3|standalone)/g).length >= 3, true);
// And it has to reach the user: the release publishes it, with fail_on_unmatched_files already asserting it
// exists, so a target that declares a proof and does not write one fails the release.
for (const [route, target] of [['Linux ARM', audioPluginLinux], ['macOS', audioPlugin], ['Windows', audioPluginWindows]]) {
  const files = renderWorkflow(target.runner, target.buildSteps(target.scaffold(empty).files), target.artifact, 'MANUAL');
  const list = files.slice(files.indexOf('files: |'), files.indexOf('fail_on_unmatched_files'));
  check(`${route}: the workflow publishes the proof beside the downloads`, list.includes(proof.BUILD_PROOF_FILE), true);
}

console.log('\n20. the cabinet: a speaker is a convolution, and it is measured against its own taps');
const cabMod = await import('../server/src/lib/cabIr.js');
const { encodeWav } = await import('../server/src/lib/audio/wav.js');
// A synthetic IR, so nothing third-party is committed and the numbers are reproducible. Exponentially
// decaying noise is what a speaker impulse looks like: an initial transient and a short tail.
const synthIr = (n, tau, seed = 3) => {
  const out = new Float64Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = ((x / 0x7fffffff) * 2 - 1) * Math.exp(-i / tau) * 0.4;
  }
  return out;
};
const irB64 = (data, sampleRate = 48000) => encodeWav({ sampleRate, data, format: 'float32' }).toString('base64');
const cabSeed = (b64) => [...empty, { path: PLUGIN_MANIFEST, content: JSON.stringify({ name: 'Amp', chain: 'amp' }) }, { path: 'models/cab.wav', content: b64, encoding: 'base64' }];

const mono = cabMod.resolveCab(cabSeed(irB64(synthIr(4800, 800))), {});
check('a mono .wav in the project is found, decoded and normalised to a peak of 1.0',
  mono.info?.channels === 1 && mono.info.taps === 4096 && Math.abs(mono.info.sourcePeak - 0.4) < 0.2
  && Math.abs(Math.max(...Array.from(mono.channels[0], Math.abs)) - 1) < 1e-6, true);
// 4800 samples is longer than the direct-convolution cap, and the tail it drops is SAID rather than dropped.
check('…a longer file is truncated to the cap, and the scaffold says so',
  mono.info.truncated === true && mono.warnings.some((w) => /only the first 4096/.test(w)), true);
check('…a silent file is refused as a cabinet rather than convolved as one',
  cabMod.resolveCab(cabSeed(irB64(new Float64Array(512))), {}).warnings.some((w) => /is silent/.test(w)), true);
check('…and a file that is not a WAV at all warns instead of throwing',
  cabMod.resolveCab(cabSeed(Buffer.from('not a wav').toString('base64')), {}).info, null);
check('…and a cabinet in a project with no chain is reported rather than silently ignored',
  audioPlugin.scaffold([...empty, { path: 'models/cab.wav', content: irB64(synthIr(512, 100)), encoding: 'base64' }])
    .warnings.some((w) => /add 'chain': 'amp'/.test(w)), true);

const cabFiles = audioPlugin.scaffold(cabSeed(irB64(synthIr(4800, 800)))).files;
const cabSrc = generated({ files: cabFiles }, 'Source/Plugin.cpp');
const cabHeaderSrc = generated({ files: cabFiles }, 'Source/CabIr.h');
const cabDataSourceSrc = generated({ files: cabFiles }, 'Source/CabIr.cpp');
check('the header names the taps, the rate and the PEAK OF THE FILE it normalised away',
  /#define MORPHEUS_CAB_TAPS 4096/.test(cabHeaderSrc) && /#define MORPHEUS_CAB_SOURCE_PEAK 0\./.test(cabHeaderSrc)
  && /#define MORPHEUS_CAB_NORMALISED 1/.test(cabHeaderSrc), true);
check('…and declares the taps the .cpp defines',
  /extern const float morpheus_cab_l\[\];/.test(cabHeaderSrc) && /const float morpheus_cab_l\[MORPHEUS_CAB_TAPS\] = \{/.test(cabDataSourceSrc), true);
// ⚠️ A `${...}` INSIDE A C++ `#if` IS NOT GUARDED. The first version emitted the right channel
// unconditionally and crashed generating a MONO cabinet, because the JavaScript runs before any
// preprocessor exists. The right channel is emitted only when there is one.
check('…and a MONO cabinet emits no right channel at all, which is what crashed the generator once',
  /morpheus_cab_r/.test(cabDataSourceSrc), false);
check('…while a stereo one emits both',
  /morpheus_cab_r\[MORPHEUS_CAB_TAPS\]/.test(generated(audioPlugin.scaffold(cabSeed(irB64([synthIr(512, 100), synthIr(512, 100)]))), 'Source/CabIr.cpp')), true);
// The same property the model has, for the same reason: the test bench patches this file to prove its own
// checks can fail, so its text must not depend on what is in the workspace.
// ⚠️ COMPARED AGAINST THE SAME CHAIN, not against the plain plugin: an amp chain and a plain plugin are
// different by design, so the first version of this compared two things that were supposed to differ.
const ampNoCab = generated(audioPlugin.scaffold([...empty, { path: PLUGIN_MANIFEST, content: JSON.stringify({ name: 'Amp', chain: 'amp' }) }]), 'Source/Plugin.cpp');
check('⭐ the plugin source is byte-identical with a cabinet and without one',
  cabSrc === ampNoCab, true);
check('…the cabinet is compiled in only through the flag the header sets',
  /#include "CabIr.h"/.test(cabSrc) && /#if MORPHEUS_HAS_CAB[\s\S]{0,900}cab_process/.test(cabSrc), true);
// ⚠️ MEASURED, NOT PREFERRED: accumulating 4096 float products into a float nulled against the JavaScript
// reference at -116 dB; in double it is -148 dB. The whole of that residual was accumulation.
check('…and the convolution accumulates in DOUBLE, which the measurement chose',
  /double y = 0\.0;/.test(cabSrc) && /return \(float\)y;/.test(cabSrc), true);
const cabCmake = generated(audioPlugin.scaffold(cabSeed(irB64(synthIr(512, 100)))), 'CMakeLists.txt');
check('…and CabIr.cpp is compiled whether or not it holds a cabinet',
  /add_library\(morpheus_plugin-impl STATIC Source\/Plugin.cpp Source\/ModelData.cpp Source\/CabIr.cpp\)/.test(cabCmake), true);
const cabCheckSrc = read('scripts/audio-amp-chain-check.mjs');
check('the check renders the cabinet through the plugin and compares it to the same taps',
  /arg\('cab'\)/.test(cabCheckSrc) && /cabTaps/.test(cabCheckSrc) && /convolveDirect\(/.test(cabCheckSrc)
  && /cabRow/.test(cabCheckSrc), true);
// Order matters and the expectation has to contain it: tone stack THEN speaker. Comparing the tone rows
// against the tone stack alone reported +22 dB of "error" that was the cabinet doing its job.
check('…and its expectation is the WHOLE chain, so the order is checked too',
  /throughChain\(toneProcess\(design, dry\)\)/.test(cabCheckSrc), true);

console.log('\n21. the gate, and the ORDER of a chain that is now six stages deep');
const ampChainMod = await import('../server/src/lib/ampChain.js');
const ampSeedNow = [...empty, { path: PLUGIN_MANIFEST, content: JSON.stringify({ name: 'Amp', chain: 'amp' }) }];
const ampNow = audioPlugin.scaffold(ampSeedNow);
const ampNowSrc = generated(ampNow, 'Source/Plugin.cpp');
const gateIds = (ampNowSrc.match(/PARAM_\w+ = \d+/g) || []).join(' ');
check('the amp chain is input, gate, three tone bands, output',
  gateIds, 'PARAM_INPUT = 1 PARAM_GATE = 2 PARAM_BASS = 3 PARAM_MID = 4 PARAM_TREBLE = 5 PARAM_OUTPUT = 6');
// ⚠️ OFF IS A STATE, NOT A VERY LOW THRESHOLD. At -80 dB the gate is still an envelope follower on the
// signal and is never exactly transparent; bypassed, it nulls against the chain with no gate at all — and
// that null is what the tone rows in audio-amp-chain-check measure, so the bypass is load-bearing.
check('…the gate\u2019s lowest setting is a BYPASS, so the default plugin is bit-for-bit the chain without it',
  ampChainMod.GATE_OFF_DB, -80);
check('…the default really is that setting, not a 0 dB threshold',
  /\{ key: 'gate', name: 'Gate', min: GATE_OFF_DB, max: 0, def: GATE_OFF_DB, role: 'gate' \}/.test(read('server/src/lib/ampChain.js')), true);
check('…and the emitted stage is guarded by exactly that comparison',
  /if \(p->smoothed\[IDX_GATE\] > \(double\)MORPHEUS_GATE_OFF_DB \+ 0\.001\) \{/.test(ampNowSrc), true);
check('…with the constant defined, not interpolated into a comment',
  /#define MORPHEUS_GATE_OFF_DB -80\.0/.test(ampNowSrc), true);
check('the gate has hysteresis, or a signal at the threshold buzzes instead of gating',
  /MORPHEUS_GATE_HYSTERESIS/.test(ampNowSrc), true);
check('…and a plain plugin has no gate code at all', /gate_process/.test(plainSrc), false);

// ⭐ THE ORDER, ASSERTED AS ORDER. A chain six stages deep is where a stage ends up in the wrong place and
// every check that only looks for its PRESENCE still passes — which is exactly what happened: the cabinet was
// emitted BEFORE the model while its own comment said "after the model", so a speaker was being convolved in
// front of the amplifier that drives it. Found by reading the emitted chain, not by a check.
const ampLoopNow = ampNowSrc.slice(ampNowSrc.indexOf('static clap_process_status plug_process'));
// Infinity when the needle is absent, so a missing stage FAILS the comparison instead of crashing the guard
// — a guard that throws is a guard whose output nobody reads.
const at = (needle) => {
  const i = ampLoopNow.indexOf(needle);
  return i < 0 ? Infinity : i;
};
check('⭐ the chain runs input, gate, tone, model, cabinet, output in that order',
  at('IDX_INPUT') < at('gate_process')
  && at('gate_process') < at('biquad_process(&p->tone[c][0]')
  && at('biquad_process(&p->tone[c][2]') < at('#if MORPHEUS_HAS_MODEL')
  && at('p->model[c]->process') < at('cab_process')
  && at('cab_process') < ampLoopNow.lastIndexOf('IDX_OUTPUT'), true);
// A gate anywhere but first is gating what the stages after it added, and cannot un-add it.
check('…and the gate is before everything that amplifies', at('gate_process') < at('p->model[c]->process'), true);
const withModelAndCab = generated(audioPlugin.scaffold([
  ...ampSeedNow, { path: 'models/amp.nam', content: '{"architecture":"Linear","weights":[1.0],"sample_rate":48000}' },
  { path: 'models/cab.wav', content: (await import('../server/src/lib/audio/wav.js')).encodeWav({ sampleRate: 48000, data: new Float64Array(256).fill(0.1), format: 'float32' }).toString('base64'), encoding: 'base64' },
]), 'Source/Plugin.cpp');
const bothLoop = withModelAndCab.slice(withModelAndCab.indexOf('static clap_process_status plug_process'));
check('…with a model AND a cabinet, the cabinet is still last of the two',
  bothLoop.indexOf('p->model[c]->process') < bothLoop.indexOf('cab_process'), true);

console.log('\n22. the chain is proven on a Pi-class CPU, with an impulse response nobody owns');
const cabGen = read('scripts/make-test-cab.mjs');
check('a synthetic cabinet is generated rather than committed, because every real IR belongs to somebody',
  cabGen.length > 500 && /encodeWav/.test(cabGen), true);
// A fixture a BUILD depends on has to be the same fixture next time, or every stored number stops being
// comparable to the next run — which is why this generator is written out rather than taken from signals.js.
check('…from a seed, with no Math.random anywhere in it',
  /SEED = \d+/.test(cabGen) && !/Math\.random/.test(cabGen), true);
check('…longer than the tap cap, so the truncation path is exercised too',
  /TAPS = (\d+)/.test(cabGen) && Number(cabGen.match(/TAPS = (\d+)/)[1]) > 4096, true);

const armRun = read('scripts/audio-plugin-linux-arm-runner-build.mjs');
check('the runner can build the amp chain and put a cabinet in it',
  /flagOn\('chain'\)/.test(armRun) && /--cab/.test(armRun) && /models\/\$\{basename\(cabArg\)\}/.test(armRun), true);
// ⚠️ A cabinet is a stage in the chain, and the plain plugin has no chain to put it in. lib/cabIr.js warns a
// USER about that; a runner is not a user and would spend a whole build discovering it.
check('…and REFUSES a cabinet without a chain rather than spending a build on it',
  /--cab needs --chain/.test(armRun), true);
check('…refusing a cabinet file that does not exist, for the same reason',
  /the cabinet \$\{cabArg\} does not exist/.test(armRun), true);
check('…and renders the chain against its design when asked, with a threshold it enforces',
  /ampChainCheck\(\{ pluginDir: OUT, cab: cabArg \|\| null, gateCase: true/.test(armRun)
  && /-120 dB this check requires/.test(armRun), true);
// ⭐ THE GATE IS MEASURED RELATIVE TO THE LOUD SECTION. Everything else in the chain changes the level — a
// cabinet moves it by +21 dB — so an absolute comparison reports the SPEAKER as a gate failure. That is
// exactly what happened the first time this ran with a cabinet in the chain.
check('⭐ the gate is measured relative to the loud section, not against the dry signal',
  /relativeDb: quietChangeDb - loudChangeDb/.test(read('scripts/audio-amp-chain-check.mjs')), true);
const chainWf = read('.github/workflows/audio-plugin-linux-arm-build.yml');
// ⚠️ THE FLAG, NOT A PREFIX OF IT. `/--chain-check/` also matches `--chain-check-disabled`, so the mutation
// that disabled the step left this check green — a substring match on a flag name is a check that a longer
// flag walks straight through.
check('the ARM workflow generates the cabinet, builds the chain and proves it',
  /make-test-cab\.mjs/.test(chainWf) && /--chain-check(?!-)/.test(chainWf) && /--chain \\/.test(chainWf), true);
check('…keeping that build\u2019s proof file with the others',
  /audio-plugin-linux-arm-chain-build\/BUILD-PROOF\.txt/.test(chainWf), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ the audio-plugin target can generate a project that will not build\n');
  process.exit(1);
}
console.log('the audio-plugin target generates a project that builds, loads, and has working parameters\n');
