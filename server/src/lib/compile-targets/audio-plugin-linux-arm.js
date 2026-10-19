// Audio Plugin compile target — **Linux on ARM (aarch64) only** — one CLAP source in, VST3 + CLAP +
// standalone out. This is the Raspberry Pi route: the artefact it produces is the one a Pi can load.
//
// WHY A SEPARATE ROUTE RATHER THAN A THIRD LEG OF ONE TARGET. Same reason as the Windows route, and Rob
// said it in as many words on 2026-10-04: *"It needs to be clear that thats a mac os only audio plugin
// route same for the windows one your about to build."* A `.vst3` is not one file format — it is a folder
// whose contents are compiled for ONE instruction set, so a build that silently targets the wrong CPU is a
// plugin that does not load, with nothing on screen to say why. An id, a label and a manual section that
// each name the machine are how a user picks correctly before they wait for a compile.
//
// ── NO AUDIO UNIT. TWO FORMATS PLUS THE STANDALONE ───────────────────────────────────────────────────────
// There is no Audio Unit outside Apple's platforms, so the CMakeLists drops it — and the AudioUnitSDK fetch
// that comes with it — on anything that is not APPLE (see lib/audioPluginTemplate.js). The standalone DOES
// build here: on Linux clap-wrapper gives it an X11 shell and RtAudio over ALSA, so the two packages this
// route installs are exactly those two (`libx11-dev`, `libasound2-dev`), and the CMake pins RtAudio/RtMidi
// off JACK so the build cannot change shape depending on what a machine happens to have installed.
//
// That X11 shell is also why the manual warns that a headless Pi runs the standalone nowhere: a Pi OS Lite
// image has no display server, and the format a headless Pi loads is the VST3 or CLAP, through a host.
//
// ── THE LINUX LAYOUT IS NEITHER THE macOS ONE NOR THE WINDOWS ONE ────────────────────────────────────────
// Measured from clap-wrapper's own `cmake/make_clapfirst.cmake` and `cmake/wrap_vst3.cmake`, which send
// each format somewhere different under the assets directory:
//
//     CLAP        -> build/assets/<name>.clap                                  (a FLAT file, not a bundle)
//     VST3        -> build/assets/<name>.vst3/Contents/<arch>-linux/<name>.so  (a folder; <arch> is the
//                                                                              CMAKE_SYSTEM_PROCESSOR, so
//                                                                              `aarch64-linux` here)
//     standalone  -> build/assets/<name>                                       (FLAT, and with NO
//                                                                              extension — that is what an
//                                                                              executable looks like on
//                                                                              Linux)
//
// So a check written for `Contents/MacOS/<name>` or for `<dir>/<name>.vst3` finds nothing here and would
// report every format missing on a build that worked. This target's verify step SEARCHES for each file
// instead of constructing its path, which is the lesson the Windows route paid for on its fourth run.
//
// The plugin PROJECT is shared with the macOS and Windows routes (lib/audioPluginProject.js): same sources,
// same identity file, and one CMakeLists that configures on all three platforms.
import { CLAP_WRAPPER_REF, CLAP_WRAPPER_REPO, PLUGIN_MANIFEST, readManifest, scaffoldPlugin, validatePlugin } from '../audioPluginProject.js';
import { namPlan } from '../namPlugin.js';
import { BUILD_PROOF_FILE, proofBash, proofHeaderBash, proofShowBash } from '../buildProof.js';

export { PLUGIN_MANIFEST, readManifest };

/** Where clap-wrapper puts every format on Linux — the DIRECTORY; the files inside it are not uniform. */
export const LINUX_ASSETS = 'build/assets';

/**
 * The runner this route is proven on.
 *
 * `ubuntu-24.04-arm` is a standard GitHub-hosted runner with an ARM64 (aarch64) CPU, available to private
 * repositories and counting against the plan's included minutes (GitHub changelog, 2026-01-29). A NATIVE
 * build is the point: cross-compiling clap-wrapper from x86 would mean cross-building the VST3 SDK and
 * finding aarch64 X11/ALSA development packages, which is a great deal of machinery to avoid one runner
 * label — and it would produce an artefact nobody had ever run the toolchain for.
 */
export const LINUX_ARM_RUNNER = 'ubuntu-24.04-arm';

/** The formats this route promises, in the order it promises them. Used by the verify step and the proof. */
export const LINUX_ARM_FORMATS = ['CLAP', 'VST3', 'standalone'];

export const audioPlugin = {
  id: 'audio-plugin-linux-arm',
  label: 'Audio Plugin — Linux ARM (VST3 · CLAP)',
  runner: LINUX_ARM_RUNNER,

  validate: validatePlugin,
  scaffold: scaffoldPlugin,

  buildSteps(files) {
    const manifest = readManifest(files);
    const name = manifest.name;
    // Shell-quoted wherever it is used. A plugin name is user-supplied text that regularly contains spaces
    // ("Morpheus Gain"), and an unquoted `find -name $name` searches for two names instead of one and fails
    // in a step that had otherwise worked.
    const qName = JSON.stringify(name);
    const qClap = JSON.stringify(`${name}.clap`);
    const qVst3So = JSON.stringify(`${name}.so`);
    const qVst3Dir = JSON.stringify(`${name}.vst3`);
    // Shared with the other two routes — see lib/namPlugin.js. Empty unless the project carries a model.
    const nam = namPlan(files, manifest);

    return [
      { uses: 'actions/checkout@v4' },

      {
        name: 'Install the Linux plugin dependencies',
        // TWO PACKAGES, AND THIS IS THE WHOLE LIST. `libx11-dev` is what the standalone's shell links
        // against (`target_link_libraries(${salib} PUBLIC X11)` in clap-wrapper); `libasound2-dev` is what
        // RtAudio — and therefore the standalone's audio device — builds against on Linux. clap-wrapper
        // configures the VST3 SDK with VSTGUI OFF, so none of the usual Linux-VST3 desktop packages
        // (cairo, fontconfig, gtkmm, xcb-*) are needed, and installing them would only make this step look
        // like it knows something it does not.
        run: [
          'set -euo pipefail',
          'sudo apt-get update',
          'sudo apt-get install -y --no-install-recommends libasound2-dev libx11-dev',
          "dpkg-query -W -f='${Package} ${Version}\\n' libasound2-dev libx11-dev",
        ].join('\n'),
      },

      {
        name: 'Fetch the plugin wrappers',
        // Shallow and pinned: this is third-party code executed as part of the user's build, so the ref is a
        // constant rather than whatever main happens to be.
        run: [
          'set -euo pipefail',
          `git clone ${CLAP_WRAPPER_REPO} "$RUNNER_TEMP/clap-wrapper"`,
          `git -C "$RUNNER_TEMP/clap-wrapper" checkout ${CLAP_WRAPPER_REF}`,
        ].join('\n'),
      },

      // Only when the project carries a model. The build with none is the gain stage it always was, so it pays
      // nothing for an engine it will not use — and every runner proof taken before this existed stays valid.
      ...(nam.hasModel ? [{
        name: 'Fetch the neural engine',
        // NeuralAmpModelerCore (MIT), the reference implementation of the .nam format, pinned to the same
        // commit the measurement CLI builds. The submodule line is load-bearing: Eigen is a submodule, and a
        // plain clone leaves the include directory empty.
        run: ['set -euo pipefail', ...nam.clone.bash].join('\n'),
      }] : []),

      {
        name: 'Configure',
        // `-DCMAKE_BUILD_TYPE=Release` because a Linux runner's default generator is SINGLE-config — the
        // opposite of the Windows route, where the Visual Studio generator ignores the variable entirely and
        // the configuration is chosen at build time instead. Writing it here is not decoration: with no
        // build type CMake configures an unoptimised plugin and says nothing about it.
        run: [
          'set -euo pipefail',
          `cmake -B build -DCMAKE_BUILD_TYPE=Release -DCLAP_WRAPPER_DIR="$RUNNER_TEMP/clap-wrapper"${nam.hasModel ? ` ${nam.configure.bash}` : ''}`,
        ].join('\n'),
      },

      {
        name: 'Build CLAP and VST3',
        // EACH FORMAT IS ITS OWN TARGET, deliberately — the same reason as the other two routes. Building
        // them together means one format's failure aborts the build before the others link, and a format
        // that was skipped is left on disk as something that passes a file-exists check.
        run: [
          'set -euo pipefail',
          'for t in morpheus_plugin_clap morpheus_plugin_vst3; do',
          '  echo "::group::building $t"',
          '  cmake --build build --target "$t"',
          '  echo "::endgroup::"',
          'done',
        ].join('\n'),
      },

      {
        name: 'Build the standalone',
        // Its own step: the standalone is the format that pulls RtAudio, RtMidi and X11, so a failure there
        // must not strand the two a musician actually loads in a host. It is also the format that needs a
        // desktop session to run at all — see the manual.
        run: [
          'set -euo pipefail',
          'cmake --build build --target morpheus_plugin_standalone',
        ].join('\n'),
      },

      {
        name: 'Verify every format is a real plugin binary for this machine',
        // THE CHECK ALL THREE ROUTES PAID FOR, adapted to this platform's layout and with one assertion the
        // other two cannot make. A VST3 folder with no binary in it, a 0-byte CLAP, or a standalone that was
        // never linked because another format failed first — all three pass "did the build produce a file?".
        // So each artefact must exist, be too big to be a stub, be an ELF image (the magic bytes, read here
        // rather than inferred from the extension) and be AArch64.
        //
        // ⭐ THE ARCHITECTURE ASSERTION IS THE POINT OF THIS ROUTE. This target's whole claim is "this
        // plugin runs on a Raspberry Pi", and the likeliest way to break that claim is to build on the wrong
        // machine and ship an x86-64 plugin with a correct-looking name. `readelf -h` answers with the
        // machine the code was compiled for, so the claim is checked against the artefact rather than
        // against the runner's label.
        //
        // THREE THINGS HERE ARE DELIBERATE, because each is a way this script silently lies:
        //   * `find -print -quit` rather than `find | head -n 1`. Under `set -o pipefail`, `head` closing the
        //     pipe early can give `find` SIGPIPE and make the whole pipeline non-zero, so `set -e` aborts a
        //     step whose search succeeded.
        //   * `grep -qw "$sym" <<< "$syms"` rather than `nm ... | grep -q`. For the same reason, inverted:
        //     `grep -q` exits at the first match, `nm` takes SIGPIPE, the pipeline is non-zero, and the `!`
        //     turns a FOUND symbol into "MISSING ENTRY POINT".
        //   * the symbols are captured once into a variable, so the check reads output that has already been
        //     read in full.
        run: [
          'set -euo pipefail',
          'bad=0',
          'check() {',
          '  fmt="$1"; file="$2"; sym="$3"',
          `  hit=$(find ${LINUX_ASSETS} -type f -name "$file" -print -quit)`,
          '  if [ -z "$hit" ]; then',
          `    echo "MISSING ($fmt): no $file anywhere under ${LINUX_ASSETS}"`,
          '    bad=$((bad + 1)); return 0',
          '  fi',
          '  size=$(stat -c%s "$hit")',
          '  if [ "$size" -lt 8192 ]; then',
          '    echo "TOO SMALL TO BE A PLUGIN ($fmt): $hit ($size bytes)"',
          '    bad=$((bad + 1)); return 0',
          '  fi',
          '  magic=$(od -An -tx1 -N4 "$hit" | tr -d " \\n")',
          '  if [ "$magic" != "7f454c46" ]; then',
          '    echo "NOT AN ELF IMAGE ($fmt): $hit (magic $magic)"',
          '    bad=$((bad + 1)); return 0',
          '  fi',
          '  machine=$(readelf -h "$hit" | sed -n "s/^ *Machine: *//p")',
          '  if [ "$machine" != "AArch64" ]; then',
          '    echo "WRONG ARCHITECTURE ($fmt): $hit is $machine, not AArch64 — this plugin would not load on the machine this route names"',
          '    bad=$((bad + 1)); return 0',
          '  fi',
          '  if [ -n "$sym" ]; then',
          '    syms=$(nm -D --defined-only "$hit" 2>/dev/null || true)',
          '    if ! grep -qw "$sym" <<< "$syms"; then',
          '      echo "MISSING ENTRY POINT $sym IN ($fmt): $hit"',
          '      bad=$((bad + 1)); return 0',
          '    fi',
          '  fi',
          '  echo "  $fmt: $hit ($size bytes, $machine)"',
          // Kept for the proof file, from the SAME values the assertions above used — so a format cannot be
          // verified and then reported differently, or reported at all when its check failed.
          '  printf -v "proof_$(echo "$fmt" | tr "A-Z" "a-z")" "%s (%s bytes, %s)" "$hit" "$size" "$machine"',
          '}',
          `check CLAP ${qClap} clap_entry`,
          `check VST3 ${qVst3So} GetPluginFactory`,
          `check standalone ${qName} ""`,
          'if [ "$bad" -gt 0 ]; then echo "the build did not produce usable plugins"; exit 1; fi',
          // ⚠️ WRITTEN AFTER THE CHECK, NOT BEFORE. A build that cannot verify something fails; it does not
          // publish a proof file with the line missing. That is why there is no "n/a" in this format.
          proofHeaderBash({ target: 'audio-plugin-linux-arm', targetLabel: 'Audio Plugin — Linux ARM (VST3 · CLAP)' }),
          proofBash({ formats: LINUX_ARM_FORMATS.map((f) => [f, f]) }),
          proofShowBash,
          'echo "all three formats produced, each an AArch64 ELF with its real entry point"',
          `echo "wrote ${BUILD_PROOF_FILE}: what this build verified, for the download beside it"`,
        ].join('\n'),
      },

      {
        name: 'Package',
        // One archive per format, because they go to different folders on the player's machine.
        //
        // ⚠️ THE VST3 IS ARCHIVED FROM INSIDE ITS OWN DIRECTORY, and that is not tidiness. `zip` stores the
        // path it was handed, so zipping `build/assets/YourPlugin.vst3` — the path `find` returns — puts
        // `build/assets/YourPlugin.vst3/…` in the archive, and a player who unzips it gets a `build/` tree
        // to dig through instead of a plugin folder to drag. `cd`-ing first and zipping the folder NAME is
        // the difference between the two, and it was checked by unzipping both.
        //
        // The VST3 is a FOLDER here (unlike Windows, where it is a single file), so it is archived
        // recursively; the two single files use `-j` so their archive holds just the file.
        run: [
          'set -euo pipefail',
          'command -v zip >/dev/null || sudo apt-get install -y --no-install-recommends zip',
          `vst3=$(find ${LINUX_ASSETS} -type d -name ${qVst3Dir} -print -quit)`,
          `clap=$(find ${LINUX_ASSETS} -type f -name ${qClap} -print -quit)`,
          `sa=$(find ${LINUX_ASSETS} -type f -name ${qName} -print -quit)`,
          '[ -n "$vst3" ] && [ -n "$clap" ] && [ -n "$sa" ] || { echo "cannot package: a format is missing"; exit 1; }',
          `( cd ${LINUX_ASSETS} && zip -qr plugin-linux-arm-vst3.zip ${qVst3Dir} )`,
          `zip -qj ${LINUX_ASSETS}/plugin-linux-arm-clap.zip "$clap"`,
          `zip -qj ${LINUX_ASSETS}/plugin-linux-arm-standalone.zip "$sa"`,
          `ls -l ${LINUX_ASSETS}/plugin-linux-arm-*.zip`,
        ].join('\n'),
      },
    ];
  },

  artifact: {
    // Three downloads, one per format. The `plugin-linux-arm-` prefix is not decoration: builds of the same
    // plugin for different machines are different files, and H20's rule is that the filename must say which
    // machine an artifact runs on — "linux-arm" names both the OS and the CPU.
    glob: `${LINUX_ASSETS}/plugin-linux-arm-*.zip`,
    isGlob: true,
    verifyCommand: `ls -l ${LINUX_ASSETS}/plugin-linux-arm-vst3.zip ${LINUX_ASSETS}/plugin-linux-arm-clap.zip ${LINUX_ASSETS}/plugin-linux-arm-standalone.zip`,
    // Published beside the downloads, so it lands in the user's _compiled/ as a file they can open — the
    // whole point being that the evidence is somewhere they already look.
    proofFile: BUILD_PROOF_FILE,
  },

  errorPatterns: [
    /CMake Error/i,
    /CLAP_WRAPPER_DIR is not set/,
    /undefined reference to/,       // a GNU link error — the class that leaves a missing binary
    /No such file or directory/,    // a missing package, most often libX11 or libasound2
    /MISSING \(/,
    /NOT AN ELF IMAGE/,
    /WRONG ARCHITECTURE/,
    /TOO SMALL TO BE A PLUGIN/,
    /MISSING ENTRY POINT/,
    /cannot package:/,
    /error: /i,
  ],
};

export default audioPlugin;
