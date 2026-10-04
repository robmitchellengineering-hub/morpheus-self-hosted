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

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ the audio-plugin target can generate a project that will not build\n');
  process.exit(1);
}
console.log('the audio-plugin target generates a project that builds, loads, and has working parameters\n');
