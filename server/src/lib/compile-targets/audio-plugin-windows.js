// Audio Plugin compile target — **Windows only** — one CLAP source in, VST3 + CLAP + standalone out.
//
// THREE FORMATS, AND THE MISSING ONE IS NOT AN OMISSION. There is no Audio Unit outside Apple's platforms,
// so the `.component` the macOS route emits cannot exist here. The generated CMakeLists drops it — and the
// AudioUnitSDK fetch that comes with it — on anything that is not APPLE (see lib/audioPluginTemplate.js).
// A musician reading "VST3 · AU · CLAP" as one product would be right to ask where the fourth file is, so
// the label says what this route actually builds and the manual says why.
//
// WHY IT IS ITS OWN ROUTE RATHER THAN A SECOND LEG OF THE macOS ONE. Rob, 2026-10-04: "It needs to be
// clear that thats a mac os only audio plugin route same for the windows one your about to build." An OS
// is not a build-matrix detail to leave the user to infer from a filename: they pick a route BEFORE the
// build, and the artifacts are then what they expect. `mac-app` and `windows-exe` are separate picker
// entries for the same reason.
//
// ── THE WINDOWS LAYOUT IS NOT THE macOS ONE, AND THE VERIFY STEP HAS TO KNOW ─────────────────────────────
// Measured from clap-wrapper's own `cmake/make_clapfirst.cmake`, which sends each format somewhere
// different under the assets directory on WIN32 — not the flat layout macOS gets:
//
//     CLAP        -> build/assets/CLAP/<name>.clap
//     VST3        -> build/assets/VST3/<name>.vst3          (a SINGLE FILE by default, not a folder bundle)
//     standalone  -> build/assets/Standalone-morpheus_plugin_standalone/<name>.exe
//
// So a check written for macOS — "look inside the bundle for Contents/MacOS/<name>" — finds nothing here
// and would report every format missing. That is the class of mistake this target's own verify step exists
// to prevent, which is why it asserts the path it actually produced rather than the path it expected.
//
// The plugin PROJECT is shared with the macOS route (lib/audioPluginProject.js): same sources, same
// identity file, and one CMakeLists that configures correctly on either platform. Only the runner, the
// commands and the packaging differ.
import { CLAP_WRAPPER_REF, CLAP_WRAPPER_REPO, PLUGIN_MANIFEST, readManifest, scaffoldPlugin, validatePlugin } from '../audioPluginProject.js';

export { PLUGIN_MANIFEST, readManifest };

/** The pinned clap-wrapper commit is shared with the macOS route — see lib/audioPluginProject.js. */
export const WINDOWS_ASSETS = 'build/assets';

export const audioPlugin = {
  id: 'audio-plugin-windows',
  label: 'Audio Plugin — Windows (VST3 · CLAP)',
  runner: 'windows-latest',

  validate: validatePlugin,
  scaffold: scaffoldPlugin,

  buildSteps(files) {
    const manifest = readManifest(files);
    const name = manifest.name;
    // WHERE clap-wrapper ACTUALLY PUTS THEM ON WINDOWS. These three paths are the ones the verify step
    // asserts, so they are built once here rather than written out at both ends.
    const clap = `${WINDOWS_ASSETS}/CLAP/${name}.clap`;
    const vst3 = `${WINDOWS_ASSETS}/VST3/${name}.vst3`;
    const standalone = `${WINDOWS_ASSETS}/Standalone-morpheus_plugin_standalone/${name}.exe`;

    return [
      { uses: 'actions/checkout@v4' },

      {
        name: 'Fetch the plugin wrappers',
        // Shallow and pinned: this is third-party code executed as part of the user's build, so the ref is
        // a constant rather than whatever main happens to be.
        // Separate lines rather than `&&`, because the runner's default Windows shell is PowerShell and a
        // failing `git clone` must stop the step rather than be reported by whatever runs next.
        run: [
          '$ErrorActionPreference = "Stop"',
          `git clone ${CLAP_WRAPPER_REPO} "$env:RUNNER_TEMP/clap-wrapper"`,
          'if ($LASTEXITCODE -ne 0) { throw "cloning clap-wrapper failed" }',
          `git -C "$env:RUNNER_TEMP/clap-wrapper" checkout ${CLAP_WRAPPER_REF}`,
          'if ($LASTEXITCODE -ne 0) { throw "checking out the pinned clap-wrapper commit failed" }',
        ].join('\n'),
      },

      {
        name: 'Configure',
        // NO -DCMAKE_BUILD_TYPE: the default generator on a Windows runner is Visual Studio, which is
        // multi-config, and CMake ignores CMAKE_BUILD_TYPE for those. The configuration is chosen at BUILD
        // time with --config Release, in every build step below.
        run: [
          '$ErrorActionPreference = "Stop"',
          'cmake -B build -DCLAP_WRAPPER_DIR="$env:RUNNER_TEMP/clap-wrapper"',
          'if ($LASTEXITCODE -ne 0) { throw "cmake configure failed" }',
        ].join('\n'),
      },

      {
        name: 'Build CLAP and VST3',
        // EACH FORMAT IS ITS OWN TARGET, deliberately — the same reason as the macOS route. Building them
        // together means one format's failure aborts the build before the others link, and a format that
        // was skipped is left on disk as something that passes a file-exists check.
        run: [
          '$ErrorActionPreference = "Stop"',
          'foreach ($t in @("morpheus_plugin_clap", "morpheus_plugin_vst3")) {',
          '  Write-Host "::group::building $t"',
          '  cmake --build build --config Release --target $t',
          '  if ($LASTEXITCODE -ne 0) { throw "build failed: $t" }',
          '  Write-Host "::endgroup::"',
          '}',
        ].join('\n'),
      },

      {
        name: 'Build the standalone',
        // Its own step: the standalone is the format that pulls RtAudio, RtMidi and (on Windows) the
        // Windows Implementation Library, and a failure there must not strand the two a musician loads in
        // a DAW. It is also the format a user can try without owning one.
        run: [
          '$ErrorActionPreference = "Stop"',
          'cmake --build build --config Release --target morpheus_plugin_standalone',
          'if ($LASTEXITCODE -ne 0) { throw "build failed: morpheus_plugin_standalone" }',
        ].join('\n'),
      },

      {
        name: 'Verify every format is a real plugin binary',
        // THE CHECK THE macOS ROUTE PAID FOR, adapted to this platform's layout. A VST3 that is 0 bytes, or
        // a standalone that was never linked because another format failed first, both pass a
        // "did the build produce a file?" check. So: the file must exist, must be a PE image (the MZ/PE
        // signature, read here rather than inferred from the extension), and must be too big to be a stub.
        //
        // The entry-point symbols are asserted only if `dumpbin` is on PATH, and the step FAILS if it is
        // not — a check that silently does not run reads as a check that passed (H17), which is the lesson
        // this repository keeps paying for.
        run: [
          '$ErrorActionPreference = "Stop"',
          'function Test-PE([string]$Path) {',
          '  $fs = [System.IO.File]::OpenRead($Path)',
          '  try {',
          '    $br = New-Object System.IO.BinaryReader($fs)',
          '    if ($br.ReadUInt16() -ne 0x5A4D) { return $false }   # MZ',
          '    $fs.Position = 0x3C',
          '    $peOffset = $br.ReadUInt32()',
          '    $fs.Position = $peOffset',
          '    return ($br.ReadUInt32() -eq 0x00004550)             # PE\\0\\0',
          '  } finally { $fs.Dispose() }',
          '}',
          `$formats = [ordered]@{`,
          `  'CLAP'       = @{ path = '${clap}';  symbol = 'clap_entry' }`,
          `  'VST3'       = @{ path = '${vst3}';  symbol = 'GetPluginFactory' }`,
          `  'standalone' = @{ path = '${standalone}'; symbol = $null }`,
          '}',
          '$dumpbin = Get-Command dumpbin -ErrorAction SilentlyContinue',
          'if (-not $dumpbin) { throw "dumpbin is not on PATH, so the entry-point assertions cannot run. Wiring the MSVC developer environment is part of this step — do not let it pass (H17)." }',
          '$bad = @()',
          'foreach ($f in $formats.Keys) {',
          '  $p = $formats[$f].path',
          '  if (-not (Test-Path $p)) { Write-Host "MISSING ($f): $p"; $bad += $f; continue }',
          '  $size = (Get-Item $p).Length',
          '  if ($size -lt 8192) { Write-Host "TOO SMALL TO BE A PLUGIN ($f): $p ($size bytes)"; $bad += $f; continue }',
          '  if (-not (Test-PE $p)) { Write-Host "NOT A PE IMAGE ($f): $p"; $bad += $f; continue }',
          '  $sym = $formats[$f].symbol',
          '  if ($sym) {',
          '    $exports = & dumpbin /nologo /exports $p | Out-String',
          '    if ($exports -notmatch "\\b$sym\\b") { Write-Host "MISSING ENTRY POINT $sym IN ($f): $p"; $bad += $f; continue }',
          '  }',
          '  Write-Host ("  {0,-11} {1,10:N0} bytes  {2}" -f $f, $size, $p)',
          '}',
          'if ($bad.Count -gt 0) { throw "the build did not produce usable plugins: $($bad -join \', \')" }',
          'Write-Host "all three formats produced, each a PE image with its real entry point"',
        ].join('\n'),
      },

      {
        name: 'Package',
        // One zip per format, because they go to different folders on the user's machine and a single
        // archive would mean unpacking all of it to use one. `Compress-Archive` preserves the file itself;
        // a VST3 here is a single file, not a folder bundle, so there is no structure to preserve.
        run: [
          '$ErrorActionPreference = "Stop"',
          `Compress-Archive -Path '${vst3}' -DestinationPath '${WINDOWS_ASSETS}/plugin-windows-vst3.zip' -Force`,
          `Compress-Archive -Path '${clap}' -DestinationPath '${WINDOWS_ASSETS}/plugin-windows-clap.zip' -Force`,
          `Compress-Archive -Path '${standalone}' -DestinationPath '${WINDOWS_ASSETS}/plugin-windows-standalone.zip' -Force`,
          `Get-ChildItem '${WINDOWS_ASSETS}/plugin-windows-*.zip' | Select-Object Name, Length`,
        ].join('\n'),
      },
    ];
  },

  artifact: {
    // Three downloads, one per format. The `plugin-windows-` prefix is not decoration: macOS and Windows
    // builds of the same plugin are different files for different machines, and H20's rule is that the
    // filename must say which machine an artifact runs on.
    glob: `${WINDOWS_ASSETS}/plugin-windows-*.zip`,
    isGlob: true,
    verifyCommand: `dir build\\assets\\plugin-windows-vst3.zip build\\assets\\plugin-windows-clap.zip build\\assets\\plugin-windows-standalone.zip`,
  },

  errorPatterns: [
    /CMake Error/i,
    /CLAP_WRAPPER_DIR is not set/,
    /error C\d{4}/,             // an MSVC compile error, named as one
    /fatal error C\d{4}/,
    /LNK\d{4}/,                 // an MSVC link error — the class that leaves a missing binary
    /MISSING ENTRY POINT/,
    /NOT A PE IMAGE/,
    /TOO SMALL TO BE A PLUGIN/,
    /'cmake' is not recognized/,
    /error: /i,
  ],
};

export default audioPlugin;
