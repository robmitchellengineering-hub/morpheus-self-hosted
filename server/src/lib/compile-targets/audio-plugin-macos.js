// Audio Plugin compile target — **macOS only** — one CLAP source in, VST3 + AU + standalone + CLAP out.
//
// THE PLATFORM IS PART OF THE NAME, THE LABEL AND THE ARTIFACTS. Audio Units are an Apple format, so the
// `.component` cannot exist on any other machine, and none of these bundles load on Windows. A user must
// know which machine their plugin is for *before* they build it — so the id is `audio-plugin-macos`, the
// picker entry says macOS, every download is `plugin-macos-*.zip`, and the manual opens by saying it.
// Windows is a separate route, not a second leg of this one.
//
// WHY THIS TARGET EXISTS, and why it is not "another like the other nine".
//
// Every other target compiles a project the user (or Morpheus) already wrote in a language the toolchain
// understands on its own. This one is different in three ways that shape everything below:
//
//   1. THERE IS NO SINGLE FORMAT. A musician does not want "a VST3" — they want something their DAW loads.
//      Reaper, Ableton and Bitwig take VST3; Logic, GarageBand and MainStage take ONLY Audio Units; the
//      standalone exists so the plugin can be tried without a DAW. clap-wrapper produces all of them from
//      ONE CLAP source, so this target emits four artifacts rather than choosing.
//
//   2. THE LICENSING IS THE PRODUCT DECISION. JUCE is the obvious framework and was rejected: its EULA
//      §1.12 forbids distributing "Products that create other Products" without a bespoke agreement, and
//      requires every end user of such software to hold their own licence — which is exactly what Morpheus
//      is. clap-wrapper, the CLAP SDK, the VST3 SDK, AudioUnitSDK, RtAudio and RtMidi are all permissive,
//      so a plugin built here carries NO licence obligation on the person who made it. That is the whole
//      reason this target is CLAP-native, and it should not be quietly swapped for something more
//      convenient later.
//
//   3. AN ARTIFACT CAN EXIST AND STILL BE EMPTY. Measured, not theorised: when one format's link step is
//      skipped (the standalone's nib compile needs full Xcode and `make` aborts), the VST3 bundle is left
//      behind as `Contents/Info.plist` with NO binary in it — a 4 KB shell where a 1.3 MB plugin should be.
//      A "did we produce a plugin file?" check passes on that. So the build verifies the BINARY inside
//      every bundle, and builds each format as its own target so one failure cannot strand another.
//
// macOS only, and the route is named for it rather than for the format. Windows will be a SEPARATE target
// (`audio-plugin-windows`) rather than a second leg of this one: an OS is not a build-matrix detail the
// user can be left to infer from a filename, and what a Windows plugin can even contain is different
// (VST3 + CLAP + standalone — there is no Audio Unit outside Apple's platforms).
import {
  auSubtypeCode, cmakeLists, entrySource, pluginSource, pluginId, fourCharCode,
} from '../audioPluginTemplate.js';
import { cloneFiles, hasFile, getFileContent, parsePackageJson } from './utils.js';

/**
 * PINNED TO A TAG, NOT A BRANCH, and it is not cosmetic.
 *
 * clap-wrapper is fetched from GitHub and compiled as part of every user's build, so `main` would mean the
 * same project builds differently on two different days, and an upstream force-push could change what
 * somebody ships without a line of this repository moving. A tag is also what makes a failure reproducible:
 * "it worked yesterday" is only a useful sentence if yesterday is a fixed commit.
 *
 * IT IS A COMMIT, NOT A TAG, AND THAT IS FORCED ON US. The newest release, v0.9.1, does not provide
 * `make_clapfirst_plugins` at all — the command this target is built on — so pinning to a tag means the
 * build cannot configure. Verified by trying it: v0.9.1 fails with `Unknown CMake command
 * "make_clapfirst_plugins"`, and its `shared_prologue.cmake` also evaluates an unquoted
 * `CMAKE_OSX_DEPLOYMENT_TARGET`, which CMake leaves EMPTY because the cache entry already exists (see the
 * Configure step, which now passes it explicitly). This commit is the one that was built, wrapped and
 * loaded through the real harness. Move it only onto a release that has the command.
 */
const CLAP_WRAPPER_REPO = 'https://github.com/free-audio/clap-wrapper.git';
const CLAP_WRAPPER_REF = '1cca996e96f29ab2be7ae9f8cfe532bbc92e1dd6';

/** The identity file the scaffold writes, and the one place a plugin's name/ID/codes are edited. */
export const PLUGIN_MANIFEST = 'morpheus.plugin.json';

/** Where a hand-written project keeps its source, if the user brought one. */
export const PLUGIN_SOURCE = 'Source/Plugin.cpp';
export const PLUGIN_ENTRY = 'Source/PluginEntry.cpp';

const DEFAULTS = { name: 'Morpheus Plugin', version: '1.0.0', paramName: 'Gain' };

/**
 * The plugin's identity, from the manifest if there is one.
 *
 * The manifest exists because `scaffold(files)` is given the project's FILES and nothing else — not the
 * project name — so the identity has to live in the files or be lost. It also happens to be the right
 * design: the name, bundle id and AU codes are what the user sees in their DAW, so they should be a file
 * they can read and edit rather than something buried in a generator.
 */
export function readManifest(files) {
  const raw = getFileContent(files, PLUGIN_MANIFEST);
  let parsed = {};
  if (raw) {
    try { parsed = JSON.parse(raw) || {}; } catch { parsed = {}; }
  }
  const pkg = parsePackageJson(files);
  const name = String(parsed.name || pkg?.name || DEFAULTS.name).trim() || DEFAULTS.name;
  const vendor = String(parsed.vendor || 'Morpheus').trim() || 'Morpheus';
  return {
    name,
    vendor,
    version: String(parsed.version || DEFAULTS.version),
    id: String(parsed.id || pluginId(name)),
    paramName: String(parsed.parameter || DEFAULTS.paramName),
    description: parsed.description ? String(parsed.description) : '',
    // `aufx` = audio effect, `augn` = instrument. The generator sets this from the request; a plugin with
    // the wrong one is filed under the wrong heading in Logic and cannot be found.
    auType: String(parsed.auType || 'aufx'),
    auSubtype: String(parsed.auSubtype || auSubtypeCode(name)),
    auManufacturer: String(parsed.auManufacturer || fourCharCode(vendor, 'Morp')),
  };
}

export const audioPlugin = {
  id: 'audio-plugin-macos',
  // The OS is in the label, not only in the downloads. This string is what a user reads in the picker and
  // in the workspace, and "Audio Plugin (VST3 · AU · CLAP)" reads as though it builds for whatever machine
  // they happen to be on — which is how someone on Windows ends up expecting a plugin they cannot load.
  label: 'Audio Plugin — macOS (VST3 · AU · CLAP)',
  runner: 'macos-latest',

  validate(files) {
    const warnings = [];
    const manifest = readManifest(files);
    const hasSource = hasFile(files, PLUGIN_SOURCE);
    const hasCmake = hasFile(files, 'CMakeLists.txt');

    // A project that brought its own CLAP source is compiled as-is. That is a supported path — it is how
    // someone continues work on a plugin Morpheus generated earlier — so it is a note, not an error.
    if (hasSource && hasCmake) {
      warnings.push('Using the CLAP project already in this workspace; Morpheus will not overwrite Source/Plugin.cpp.');
    }
    if (hasSource && !hasCmake) {
      warnings.push('Source/Plugin.cpp is present but there is no CMakeLists.txt — one will be generated around it.');
    }
    // The AU codes are four characters and are how Logic names and finds the plugin. Two plugins sharing
    // a subtype shadow each other, which is invisible until one goes missing.
    if (manifest.auSubtype.length !== 4 || manifest.auManufacturer.length !== 4) {
      warnings.push('AU registration codes are not four characters; Logic may not list this plugin correctly.');
    }
    if (!/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(manifest.id)) {
      warnings.push(`Plugin id "${manifest.id}" does not look like a reverse-domain identifier.`);
    }
    return { valid: true, warnings };
  },

  /**
   * Generate the plugin project. Anything already present is left alone, so this is safe to run over a
   * project someone has edited — regenerating a user's DSP would be the worst possible behaviour here.
   */
  scaffold(files) {
    const warnings = [];
    const generated = [];
    const out = cloneFiles(files);
    const manifest = readManifest(files);

    const add = (path, content) => {
      if (hasFile(out, path)) return;
      out.push({ path, content });
      generated.push(path);
    };

    add(PLUGIN_MANIFEST, `${JSON.stringify({
      name: manifest.name,
      vendor: manifest.vendor,
      version: manifest.version,
      id: manifest.id,
      parameter: manifest.paramName,
      description: manifest.description,
      auType: manifest.auType,
      auSubtype: manifest.auSubtype,
      auManufacturer: manifest.auManufacturer,
    }, null, 2)}\n`);

    add(PLUGIN_SOURCE, pluginSource(manifest));
    add(PLUGIN_ENTRY, entrySource());
    add('CMakeLists.txt', cmakeLists({
      name: manifest.name,
      id: manifest.id,
      version: manifest.version,
      auType: manifest.auType,
      auSubtype: manifest.auSubtype,
      auManufacturer: manifest.auManufacturer,
      auManufacturerName: manifest.vendor,
    }));

    // The entry file exports three symbols that our Plugin.cpp defines. Over somebody else's source that
    // is a link error with no explanation, so say it here rather than in a build log they will not read.
    if (hasFile(files, PLUGIN_SOURCE) && generated.includes(PLUGIN_ENTRY)) {
      warnings.push(
        `${PLUGIN_ENTRY} was generated to match Morpheus's own source, so your ${PLUGIN_SOURCE} must export `
        + 'morpheus_plugin_init, morpheus_plugin_deinit and morpheus_plugin_get_factory — or supply your own '
        + `${PLUGIN_ENTRY}.`,
      );
    }
    return { files: out, generated, warnings };
  },

  buildSteps(files) {
    const manifest = readManifest(files);
    const assets = 'build/assets';
    // Quoted because a plugin name contains spaces, and every one of these paths is built from the name.
    const bundle = (ext) => `${assets}/${manifest.name}${ext}`;

    return [
      { uses: 'actions/checkout@v4' },

      {
        name: 'Fetch the plugin wrappers',
        // Shallow and pinned: this is third-party code executed as part of the user's build, so the ref is
        // a constant in this file rather than whatever main happens to be.
        // `--branch` accepts a tag OR a commit, and a commit is what the pin is (see CLAP_WRAPPER_REF).
        run: `git clone ${CLAP_WRAPPER_REPO} "$RUNNER_TEMP/clap-wrapper" && git -C "$RUNNER_TEMP/clap-wrapper" checkout ${CLAP_WRAPPER_REF}`,
      },

      {
        name: 'Configure',
        // Universal on purpose. An Apple-silicon-only plugin is refused outright by an Intel Mac and a
        // plugin that will not load looks exactly like a plugin that was never installed (H20).
        run: [
          'cmake -B build -DCMAKE_BUILD_TYPE=Release \\',
          `  -DCLAP_WRAPPER_DIR="$RUNNER_TEMP/clap-wrapper" \\`,
          '  -DCMAKE_OSX_ARCHITECTURES="arm64;x86_64" \\',
          // PASSED EXPLICITLY, because setting it in CMakeLists is silently ignored: CMake already has
          // CMAKE_OSX_DEPLOYMENT_TARGET in its cache (empty), and a plain `set(... CACHE ...)` does not
          // overwrite an existing cache entry. A wrapper that reads the variable then sees "" — which on
          // at least one version is a hard configure error, and on another silently changes which
          // filesystem library gets linked.
          '  -DCMAKE_OSX_DEPLOYMENT_TARGET=10.13',
        ].join('\n'),
      },

      {
        name: 'Build CLAP, VST3 and AU',
        // EACH FORMAT IS ITS OWN TARGET, deliberately. Building them together means one format's failure
        // aborts `make` before the others link, and the ones that were skipped are left on disk as bundle
        // directories with an Info.plist and no binary — which reads as success to a file-exists check.
        run: [
          'set -e',
          'for t in morpheus_plugin_clap morpheus_plugin_vst3 morpheus_plugin_auv2; do',
          '  echo "::group::building $t"',
          '  cmake --build build --target "$t" -j"$(sysctl -n hw.ncpu)"',
          '  echo "::endgroup::"',
          'done',
        ].join('\n'),
      },

      {
        name: 'Build the standalone',
        // Last, and its own step, because it is the only format whose macOS shell needs full Xcode
        // (ibtool compiles MainMenu.nib). Separated so its failure cannot strand the three that matter
        // most, and so the failure is legible when it happens.
        run: [
          'set -e',
          'cmake --build build --target morpheus_plugin_standalone -j"$(sysctl -n hw.ncpu)"',
        ].join('\n'),
      },

      {
        name: 'Verify every bundle contains its binary',
        // THE CHECK THAT WOULD HAVE CAUGHT AN EMPTY PLUGIN. A `.vst3` with no Mach-O inside it is a
        // directory that exists, uploads, downloads, and fails to load — with nothing anywhere saying so.
        // The entry-point symbol is asserted too, because a Mach-O that is not the plugin passes every
        // other check here and fails in the host instead.
        run: [
          'set -e',
          'check() {',
          '  b="$1"; sym="$2"',
          '  test -d "$b" || { echo "MISSING BUNDLE: $b"; exit 1; }',
          '  bin="$b/Contents/MacOS/$(basename "$b" | sed \'s/\\.[^.]*$//\')"',
          '  test -f "$bin" || { echo "BUNDLE HAS NO BINARY: $b"; exit 1; }',
          '  file "$bin" | grep -q "Mach-O" || { echo "NOT A MACH-O: $bin"; exit 1; }',
          '  if [ "$sym" != "-" ]; then',
          '    nm -gU "$bin" 2>/dev/null | grep -q " _$sym$" || { echo "MISSING ENTRY POINT $sym IN: $b"; exit 1; }',
          '  fi',
          '  echo "  $b $(lipo -archs "$bin")"',
          '}',
          'echo "Format                Architectures"',
          `check "${bundle('.clap')}" clap_entry`,
          `check "${bundle('.vst3')}" GetPluginFactory`,
          `check "${bundle('.component')}" wrapAsAUV2_inst0Factory`,
          // The standalone is checked for its binary like the rest; `-` skips the symbol assertion because
          // its entry is the ordinary `main` of an executable, not a plugin entry point.
          `check "${bundle('.app')}" -`,
          'echo "all four formats produced, each with a binary and a real entry point"',
        ].join('\n'),
      },

      {
        name: 'Package',
        // `ditto` rather than `zip`, because it is the macOS tool that preserves a bundle's structure and
        // permissions; a plugin that arrives without its executable bit is a plugin that does not load.
        run: [
          'set -e',
          `cd ${assets}`,
          `ditto -c -k --sequesterRsrc --keepParent "${manifest.name}.vst3" plugin-macos-vst3.zip`,
          `ditto -c -k --sequesterRsrc --keepParent "${manifest.name}.component" plugin-macos-au.zip`,
          `ditto -c -k --sequesterRsrc --keepParent "${manifest.name}.clap" plugin-macos-clap.zip`,
          `ditto -c -k --sequesterRsrc --keepParent "${manifest.name}.app" plugin-macos-standalone.zip`,
          'ls -la ./*.zip',
        ].join('\n'),
      },
    ];
  },

  artifact: {
    // Four downloads, one per format, because they go to four different places on a musician's machine
    // and a single archive would mean unpacking all of it to use one. `${{ matrix.arch }}` is absent since
    // this build is universal — see the Configure step, and H20's rule that the filename must say which
    // machine an artifact runs on.
    glob: `${'build/assets'}/plugin-macos-*.zip`,
    isGlob: true,
    verifyCommand: `ls build/assets/plugin-macos-vst3.zip build/assets/plugin-macos-au.zip build/assets/plugin-macos-clap.zip build/assets/plugin-macos-standalone.zip`,
  },

  errorPatterns: [
    /CMake Error/i,
    /Missing variable is: CMAKE_OBJCXX_COMPILE_OBJECT/,
    /CLAP_WRAPPER_DIR is not set/,
    /requires Xcode/,
    /BUNDLE HAS NO BINARY/,
    /MISSING BUNDLE/,
    /No such file or directory: 'cmake'/,
    /error: /i,
  ],
};

export default audioPlugin;
