// Audio Plugin compile target — **macOS only** — one CLAP source in, VST3 + AU + standalone + CLAP out.
//
// THE PLATFORM IS PART OF THE NAME, THE LABEL AND THE ARTIFACTS. Audio Units are an Apple format, so the
// `.component` cannot exist on any other machine, and none of these bundles load on Windows. A user must
// know which machine their plugin is for *before* they build it — so the id is `audio-plugin-macos`, the
// picker entry says macOS, every download is `plugin-macos-*.zip`, and the manual opens by saying it.
// Windows is a separate route (`audio-plugin-windows`), not a second leg of this one.
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
// macOS only, and the route is named for it rather than for the format. Windows is a SEPARATE target
// (`audio-plugin-windows`) rather than a second leg of this one: an OS is not a build-matrix detail the
// user can be left to infer from a filename, and what a Windows plugin can even contain is different
// (VST3 + CLAP + standalone — there is no Audio Unit outside Apple's platforms).
//
// The PROJECT both routes generate — identity, validation, the four files — is in lib/audioPluginProject.js,
// shared deliberately: two copies of a generator is how two routes come to build different plugins while
// both look correct.
import { CLAP_WRAPPER_REF, CLAP_WRAPPER_REPO } from '../audioPluginProject.js';
import {
  PLUGIN_ENTRY, PLUGIN_MANIFEST, PLUGIN_SOURCE, readManifest, scaffoldPlugin, validatePlugin,
} from '../audioPluginProject.js';
import { namPlan } from '../namPlugin.js';
import { BUILD_PROOF_FILE, proofBash, proofHeaderBash, proofShowBash } from '../buildProof.js';

// Re-exported because this module's id is where the shared project is reached from, and the guard reads
// the identity file's name out of here.
export { PLUGIN_ENTRY, PLUGIN_MANIFEST, PLUGIN_SOURCE, readManifest };

export const audioPlugin = {
  id: 'audio-plugin-macos',
  // The OS is in the label, not only in the downloads. This string is what a user reads in the picker and
  // in the workspace, and "Audio Plugin (VST3 · AU · CLAP)" reads as though it builds for whatever machine
  // they happen to be on — which is how someone on Windows ends up expecting a plugin they cannot load.
  label: 'Audio Plugin — macOS (VST3 · AU · CLAP)',
  runner: 'macos-latest',

  validate: validatePlugin,
  scaffold: scaffoldPlugin,

  buildSteps(files) {
    const manifest = readManifest(files);
    const assets = 'build/assets';
    // Quoted because a plugin name contains spaces, and every one of these paths is built from the name.
    const bundle = (ext) => `${assets}/${manifest.name}${ext}`;
    // A model makes this build fetch a second third-party repository and compile it in. Nothing about that
    // is macOS-specific, so the plan comes from lib/namPlugin.js and all three routes ask the same question.
    const nam = namPlan(files, manifest);

    return [
      { uses: 'actions/checkout@v4' },

      {
        name: 'Fetch the plugin wrappers',
        // Shallow and pinned: this is third-party code executed as part of the user's build, so the ref is
        // a constant rather than whatever main happens to be. `--branch` accepts a tag OR a commit, and a
        // commit is what the pin is (see CLAP_WRAPPER_REF).
        run: `git clone ${CLAP_WRAPPER_REPO} "$RUNNER_TEMP/clap-wrapper" && git -C "$RUNNER_TEMP/clap-wrapper" checkout ${CLAP_WRAPPER_REF}`,
      },

      // Only when the project carries a model. A build with none is the gain stage it always was, so it does
      // not pay for a second clone or a second third-party compile it will not use.
      ...(nam.hasModel ? [{
        name: 'Fetch the neural engine',
        // The engine the plugin runs the model on — NeuralAmpModelerCore (MIT), the reference implementation
        // of the .nam format, pinned to the same commit the measurement CLI builds. The submodules matter:
        // Eigen is one, and a plain clone leaves the include directory empty.
        run: nam.clone.bash.join('\n'),
      }] : []),

      {
        name: 'Configure',
        // Universal on purpose. An Apple-silicon-only plugin is refused outright by an Intel Mac and a
        // plugin that will not load looks exactly like a plugin that was never installed (H20).
        run: [
          'cmake -B build -DCMAKE_BUILD_TYPE=Release \\',
          `  -DCLAP_WRAPPER_DIR="$RUNNER_TEMP/clap-wrapper" \\`,
          ...(nam.hasModel ? [`  ${nam.configure.bash} \\`] : []),
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
          '  label="$1"; b="$2"; sym="$3"',
          '  test -d "$b" || { echo "MISSING BUNDLE: $b"; exit 1; }',
          '  bin="$b/Contents/MacOS/$(basename "$b" | sed \'s/\\.[^.]*$//\')"',
          '  test -f "$bin" || { echo "BUNDLE HAS NO BINARY: $b"; exit 1; }',
          '  file "$bin" | grep -q "Mach-O" || { echo "NOT A MACH-O: $bin"; exit 1; }',
          '  if [ "$sym" != "-" ]; then',
          '    nm -gU "$bin" 2>/dev/null | grep -q " _$sym$" || { echo "MISSING ENTRY POINT $sym IN: $b"; exit 1; }',
          '  fi',
          '  archs="$(lipo -archs "$bin")"',
          '  echo "  $b $archs"',
          // Kept for the proof file, from the same values the assertions above used.
          '  printf -v "proof_$(echo "$label" | tr "A-Z" "a-z")" "%s (%s)" "$b" "$archs"',
          '}',
          'echo "Format                Architectures"',
          `check CLAP "${bundle('.clap')}" clap_entry`,
          `check VST3 "${bundle('.vst3')}" GetPluginFactory`,
          `check AU "${bundle('.component')}" wrapAsAUV2_inst0Factory`,
          // The standalone is checked for its binary like the rest; `-` skips the symbol assertion because
          // its entry is the ordinary `main` of an executable, not a plugin entry point.
          `check standalone "${bundle('.app')}" -`,
          // ⚠️ AFTER THE CHECKS, so a build that could not verify a format fails rather than publishing a
          // proof file with the line missing.
          proofHeaderBash({ target: 'audio-plugin-macos', targetLabel: 'Audio Plugin — macOS (VST3 · AU · CLAP)' }),
          proofBash({ formats: [['CLAP', ''], ['VST3', ''], ['AU', ''], ['standalone', '']] }),
          proofShowBash,
          'echo "all four formats produced, each with a binary and a real entry point"',
          `echo "wrote ${BUILD_PROOF_FILE}: what this build verified, for the download beside it"`,
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
    // Published beside the downloads, so it lands in the user's _compiled/ where they already look.
    proofFile: BUILD_PROOF_FILE,
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
